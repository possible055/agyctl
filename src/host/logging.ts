// Node-side structured event logging for command tooling (continuation
// plan §4): a typed JSONL writer with segment rotation and a bounded retention
// sweep. The CLI and the Host process each own an independent writer and runId
// so two processes never share a file. Preload and renderer code never import
// this module.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TOOLING_EVENT_SCHEMA_VERSION,
  type ToolingEvent,
  type ToolingEventInput,
} from './contracts.js';

export class LoggingError extends Error {
  constructor(
    readonly code: 'LOG_WRITE_FAILED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LoggingError';
  }
}

export interface JsonlEventWriterOptions {
  /** Directory receiving this run's segments: logs/<installationId-or-offline>. */
  directory: string;
  maxSegmentBytes?: number;
  maxClosedSegments?: number;
  /** Closed segments fresher than this may still be active in another process. */
  activeGraceMs?: number;
}

export type EventSink = (event: ToolingEventInput) => void;

export interface EventSinkContext {
  operationId: string;
  installationId?: string;
}

const DEFAULT_MAX_SEGMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CLOSED_SEGMENTS = 20;
const DEFAULT_ACTIVE_GRACE_MS = 10 * 60 * 1000;
const MAX_DETAIL_LENGTH = 2000;
const SEGMENT_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.jsonl$/;

const EVENT_STRING_FIELDS = [
  'installationId',
  'planId',
  'artifactId',
  'locale',
  'adapterId',
  'sourceIdentity',
  'messageId',
  'member',
  'code',
] as const;

/** Serializes only whitelisted fields, so an arbitrary error object can never
 * leak whole payloads, headers or user content into the log. */
function serializeEvent(event: ToolingEvent): string {
  const line: Record<string, unknown> = {
    schemaVersion: event.schemaVersion,
    timestamp: event.timestamp,
    level: event.level,
    runId: event.runId,
    operationId: event.operationId,
    component: event.component,
    stage: event.stage,
    event: event.event,
    result: event.result,
  };
  for (const field of EVENT_STRING_FIELDS) {
    const value = event[field];
    if (typeof value === 'string' && value.length > 0) line[field] = value;
  }
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs))
    line.durationMs = event.durationMs;
  if (event.counts) {
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(event.counts))
      if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
    line.counts = counts;
  }
  if (typeof event.detail === 'string' && event.detail.length > 0)
    line.detail =
      event.detail.length > MAX_DETAIL_LENGTH
        ? `${event.detail.slice(0, MAX_DETAIL_LENGTH)}…`
        : event.detail;
  return JSON.stringify(line);
}

export class JsonlEventWriter {
  readonly runId = randomUUID();
  readonly directory: string;
  readonly #maxSegmentBytes: number;
  readonly #maxClosedSegments: number;
  readonly #activeGraceMs: number;
  #fd: number | null = null;
  #segment = 0;
  #bytes = 0;

  constructor(options: JsonlEventWriterOptions) {
    this.directory = options.directory;
    this.#maxSegmentBytes = Math.max(1024, options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES);
    this.#maxClosedSegments = options.maxClosedSegments ?? DEFAULT_MAX_CLOSED_SEGMENTS;
    this.#activeGraceMs = options.activeGraceMs ?? DEFAULT_ACTIVE_GRACE_MS;
    // Creating the first segment up front is the gate: when this fails the
    // caller reports LOG_WRITE_FAILED before any mutating step runs.
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      this.#openSegment();
    } catch (error) {
      throw new LoggingError(
        'LOG_WRITE_FAILED',
        `Could not create the tooling log at ${this.directory}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  get activePath(): string {
    return this.#segmentPath(this.#segment);
  }

  write(event: ToolingEvent): void {
    if (this.#fd === null)
      throw new LoggingError('LOG_WRITE_FAILED', 'The tooling log writer is closed');
    let line: string;
    try {
      line = `${serializeEvent(event)}\n`;
    } catch (error) {
      throw new LoggingError('LOG_WRITE_FAILED', `Could not serialize a tooling event: ${(error as Error).message}`, {
        cause: error,
      });
    }
    try {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (this.#bytes > 0 && this.#bytes + bytes > this.#maxSegmentBytes) this.#rotate();
      fs.writeSync(this.#fd, line, null, 'utf8');
      this.#bytes += bytes;
    } catch (error) {
      this.#fd = null;
      throw new LoggingError(
        'LOG_WRITE_FAILED',
        `Could not append to the tooling log at ${this.activePath}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  close(): void {
    if (this.#fd === null) return;
    const fd = this.#fd;
    this.#fd = null;
    this.#bytes = 0;
    try {
      fs.closeSync(fd);
    } catch (error) {
      throw new LoggingError(
        'LOG_WRITE_FAILED',
        `Could not close the tooling log at ${this.#segmentPath(this.#segment)}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    this.#pruneClosedSegments(true);
  }

  #segmentPath(segment: number): string {
    return path.join(this.directory, `${this.runId}.${segment}.jsonl`);
  }

  #openSegment(): void {
    this.#segment += 1;
    this.#fd = fs.openSync(this.#segmentPath(this.#segment), 'wx');
    this.#bytes = 0;
  }

  #rotate(): void {
    const fd = this.#fd;
    if (fd !== null) fs.closeSync(fd);
    this.#fd = null;
    this.#openSegment();
    this.#pruneClosedSegments();
  }

  /**
   * Keeps only the newest closed segments. Files modified recently may belong
   * to a live process and are never deleted; failures are best-effort because
   * the log write itself already succeeded. `includeFinal` counts the segment
   * closed by close() against the cap.
   */
  #pruneClosedSegments(includeFinal = false): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return;
    }
    const active = includeFinal ? null : path.basename(this.activePath);
    const closed: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      if ((active !== null && name === active) || !SEGMENT_NAME_PATTERN.test(name)) continue;
      try {
        const mtimeMs = fs.statSync(path.join(this.directory, name)).mtimeMs;
        // Floor the timestamp: NTFS reports fractional milliseconds, which can
        // sit ahead of the integer Date.now() and would wrongly mark a
        // just-written segment as protected by the grace window.
        if (this.#activeGraceMs > 0 && Date.now() - Math.floor(mtimeMs) < this.#activeGraceMs) continue;
        closed.push({ name, mtimeMs });
      } catch {
        /* vanished concurrently */
      }
    }
    closed.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name, 'en', { numeric: true }));
    const excess = closed.length - this.#maxClosedSegments;
    for (let index = 0; index < excess; index++) {
      try {
        fs.rmSync(path.join(this.directory, closed[index].name), { force: true });
      } catch {
        /* retention is best-effort */
      }
    }
  }
}

/**
 * Binds the envelope fields (schemaVersion, timestamp, runId, operationId,
 * component) so every call site emits the same contract.
 */
export function createEventSink(
  writer: JsonlEventWriter,
  context: { component: string } & EventSinkContext,
  onEvent?: (event: ToolingEvent) => void,
): EventSink {
  return (input) => {
    const event: ToolingEvent = {
      ...input,
      schemaVersion: TOOLING_EVENT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      runId: writer.runId,
      operationId: context.operationId,
      component: context.component,
      installationId: context.installationId ?? input.installationId,
    };
    writer.write(event);
    onEvent?.(event);
  };
}

export interface GuardedEventSink {
  sink: EventSink;
  /** Marks the point after which diagnostic failures no longer abort the operation. */
  markMutating(): void;
  /** The first tolerated failure, if the log degraded after the mutation point. */
  failure(): LoggingError | null;
}

/**
 * Wraps a sink so post-mutation diagnostic failures never change the reported
 * outcome of an already-committed transaction (continuation plan §4.4). Before
 * the mutation point the error still propagates: nothing is written without a
 * log.
 */
export function createGuardedEventSink(sink: EventSink): GuardedEventSink {
  let mutating = false;
  let failure: LoggingError | null = null;
  return {
    sink: (event) => {
      try {
        sink(event);
      } catch (error) {
        if (!mutating) throw error;
        failure ??=
          error instanceof LoggingError
            ? error
            : new LoggingError('LOG_WRITE_FAILED', String(error));
      }
    },
    markMutating: () => {
      mutating = true;
    },
    failure: () => failure,
  };
}

export interface CommandLogInfo {
  runId: string;
  operationId: string;
  directory: string;
  path: string;
}

/** Shared command-owned log: creation gates writes, later failures remain diagnostic. */
export class ToolingCommandLog {
  readonly operationId = randomUUID();
  readonly #writer: JsonlEventWriter | null;
  readonly #guarded: GuardedEventSink;
  #failure: LoggingError | null = null;

  constructor(options: {
    directory: string;
    component: string;
    installationId?: string;
    required: boolean;
  }) {
    let writer: JsonlEventWriter | null = null;
    try {
      writer = new JsonlEventWriter({ directory: options.directory });
    } catch (error) {
      if (options.required) throw error;
      this.#failure =
        error instanceof LoggingError ? error : new LoggingError('LOG_WRITE_FAILED', String(error));
      console.error(`${this.#failure.code}: ${this.#failure.message}; continuing without a JSONL log`);
    }
    this.#writer = writer;
    const sink: EventSink = writer
      ? createEventSink(
          writer,
          { component: options.component, operationId: this.operationId, installationId: options.installationId },
          (event) => { if (event.level !== 'debug') console.error(formatEventDiagnostic(event)); },
        )
      : () => {};
    this.#guarded = createGuardedEventSink(sink);
  }

  get sink(): EventSink {
    return this.#guarded.sink;
  }

  markMutating(): void {
    this.#guarded.markMutating();
  }

  failure(): LoggingError | null {
    return this.#guarded.failure() ?? this.#failure;
  }

  describe(): CommandLogInfo | null {
    return this.#writer
      ? {
          runId: this.#writer.runId,
          operationId: this.operationId,
          directory: this.#writer.directory,
          path: this.#writer.activePath,
        }
      : null;
  }

  close(): void {
    try {
      this.#writer?.close();
    } catch (error) {
      this.#failure ??=
        error instanceof LoggingError ? error : new LoggingError('LOG_WRITE_FAILED', String(error));
    }
  }
}

/** One-line stderr summary for a structured event. */
export function formatEventDiagnostic(event: ToolingEvent): string {
  const identifiers = [
    event.code ? `code=${event.code}` : null,
    event.messageId ? `message=${event.messageId}` : null,
    event.member ? `member=${event.member}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const head = `agyctl ${event.component}.${event.stage} ${event.event} ${event.result}`;
  return `${head}${identifiers ? ` (${identifiers})` : ''}${event.detail ? `: ${event.detail}` : ''}`;
}
