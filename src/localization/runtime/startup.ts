import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JsonlEventWriter, createEventSink, type EventSink } from '../../host/logging.js';
import type { LocalizationEventInput } from '../contracts.js';
import { decodeManifest, readArtifactDelivery } from '../artifact.js';

const HEX64 = /^[a-f0-9]{64}$/;
const LOCALE_ID = /^[\w-]+$/;

export type StartupErrorCode =
  | 'RUNTIME_CONFIG_INVALID'
  | 'SELECTION_MISSING'
  | 'SELECTION_INVALID'
  | 'ARTIFACT_INVALID';

export class StartupError extends Error {
  constructor(
    readonly code: StartupErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StartupError';
  }
}

export type ReadText = (filePath: string) => string;

function defaultReadText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function parseJson(text: string, source: string, code: StartupErrorCode): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StartupError(code, `${source} is not valid JSON`, { cause: error });
  }
}

function asObject(raw: unknown, source: string, code: StartupErrorCode): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new StartupError(code, `${source} must contain one JSON object`);
  return raw as Record<string, unknown>;
}

function hex64(value: unknown, source: string, field: string, code: StartupErrorCode): string {
  if (typeof value !== 'string' || !HEX64.test(value))
    throw new StartupError(code, `${source}: ${field} must be a 64-hex string`);
  return value;
}

function localeId(value: unknown, source: string, field: string, code: StartupErrorCode): string {
  if (typeof value !== 'string' || !LOCALE_ID.test(value))
    throw new StartupError(code, `${source}: ${field} must be a locale id`);
  return value;
}

/** schemaVersion 2: the ASAR pins only the tool state location and installation. */
export interface SelectionRuntimeConfig {
  kind: 'selection';
  stateRoot: string;
  installationId: string;
}

export type RuntimeConfig = SelectionRuntimeConfig;

export function readRuntimeConfig(
  configDir: string,
  readText: ReadText = defaultReadText,
): RuntimeConfig {
  return decodeRuntimeConfig(
    parseJson(
      readText(path.join(configDir, 'runtime-config.json')),
      'runtime-config.json',
      'RUNTIME_CONFIG_INVALID',
    ),
    'runtime-config.json',
  );
}

export function decodeRuntimeConfig(raw: unknown, source: string): RuntimeConfig {
  const record = asObject(raw, source, 'RUNTIME_CONFIG_INVALID');
  if (record.schemaVersion === 2) {
    const stateRoot = record.stateRoot;
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot))
      throw new StartupError(
        'RUNTIME_CONFIG_INVALID',
        `${source}: stateRoot must be an absolute path`,
      );
    return {
      kind: 'selection',
      stateRoot,
      installationId: hex64(
        record.installationId,
        source,
        'installationId',
        'RUNTIME_CONFIG_INVALID',
      ),
    };
  }
  throw new StartupError(
    'RUNTIME_CONFIG_INVALID',
    `${source}: unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}`,
  );
}

export interface SelectionSnapshot {
  schemaVersion: 1;
  installationId: string;
  artifactId: string;
  locale: string;
  selectedAt: string;
}

export function decodeSelectionSnapshot(raw: unknown, source: string): SelectionSnapshot {
  const record = asObject(raw, source, 'SELECTION_INVALID');
  if (record.schemaVersion !== 1)
    throw new StartupError('SELECTION_INVALID', `${source}: unsupported schemaVersion`);
  const selectedAt = record.selectedAt;
  if (typeof selectedAt !== 'string' || Number.isNaN(Date.parse(selectedAt)))
    throw new StartupError('SELECTION_INVALID', `${source}: selectedAt must be an ISO timestamp`);
  return {
    schemaVersion: 1,
    installationId: hex64(record.installationId, source, 'installationId', 'SELECTION_INVALID'),
    artifactId: hex64(record.artifactId, source, 'artifactId', 'SELECTION_INVALID'),
    locale: localeId(record.locale, source, 'locale', 'SELECTION_INVALID'),
    selectedAt,
  };
}

export interface ArtifactManifestProjection {
  artifactId: string;
  locale: string;
  sourceMainSha256: string;
  mainSha256: string;
}

export function decodeArtifactManifest(raw: unknown, source: string): ArtifactManifestProjection {
  let record;
  try {
    record = decodeManifest(raw);
  } catch (error) {
    throw new StartupError(
      'ARTIFACT_INVALID',
      `${source}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const asset = record.assets.find((entry) => entry.route === '/main.js');
  if (!asset) throw new StartupError('ARTIFACT_INVALID', `${source}: no /main.js asset entry`);
  return {
    artifactId: record.artifactId,
    locale: record.locale,
    sourceMainSha256: record.sourceMainSha256,
    mainSha256: asset.sha256,
  };
}

/** The verified startup binding the coordinator delivers from. */
export interface StartupSnapshot {
  mode: 'selection';
  stateRoot: string;
  installationId: string;
  artifactId: string;
  locale: string;
  sourceMainSha256: string;
  mainSha256: string;
}

/**
 * Resolves the startup binding from the installed runtime config. Selection
 * mode reads and verifies selection.json plus the artifact manifest and its main.js bytes.
 */
export function resolveStartupSnapshot(
  configDir: string,
  io: { readText?: ReadText; config?: RuntimeConfig } = {},
): StartupSnapshot {
  const readText = io.readText ?? defaultReadText;
  const config = io.config ?? readRuntimeConfig(configDir, readText);
  const selectionPath = path.join(
    config.stateRoot,
    'installations',
    config.installationId,
    'selection.json',
  );
  let selectionRaw: unknown;
  try {
    selectionRaw = parseJson(readText(selectionPath), 'selection.json', 'SELECTION_INVALID');
  } catch (error) {
    if (error instanceof StartupError && error.code === 'SELECTION_INVALID') throw error;
    throw new StartupError(
      'SELECTION_MISSING',
      `No readable localization selection exists for installation ${config.installationId}; the original interface loads`,
      { cause: error },
    );
  }
  const selection = decodeSelectionSnapshot(selectionRaw, 'selection.json');
  if (selection.installationId !== config.installationId)
    throw new StartupError(
      'SELECTION_INVALID',
      'selection.json belongs to a different installation',
    );
  const artifactDir = path.join(config.stateRoot, 'artifacts', selection.artifactId);
  let manifest;
  try {
    const validated = readArtifactDelivery(artifactDir, { artifactId: selection.artifactId });
    manifest = decodeArtifactManifest(validated.manifest, 'manifest.json');
  } catch (error) {
    if (error instanceof StartupError) throw error;
    throw new StartupError(
      'ARTIFACT_INVALID',
      `Selected artifact could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (manifest.artifactId !== selection.artifactId)
    throw new StartupError(
      'ARTIFACT_INVALID',
      'Artifact manifest does not match the selected artifact id',
    );
  if (manifest.locale !== selection.locale)
    throw new StartupError(
      'SELECTION_INVALID',
      'selection.json locale does not match the artifact manifest',
    );
  return {
    mode: 'selection',
    stateRoot: config.stateRoot,
    installationId: config.installationId,
    artifactId: selection.artifactId,
    locale: selection.locale,
    sourceMainSha256: manifest.sourceMainSha256,
    mainSha256: manifest.mainSha256,
  };
}

export interface RuntimeStatusSnapshot {
  schemaVersion: 1;
  lastKnown: true;
  runId: string;
  installationId: string | null;
  artifactId: string | null;
  locale: string | null;
  healthState: string;
  logging: 'active' | 'unavailable';
  startedAt: string;
  updatedAt: string;
  terminal: { code: string; message: string; at: string } | null;
}

export function decodeRuntimeStatus(raw: unknown, source: string): RuntimeStatusSnapshot {
  const record = asObject(raw, source, 'RUNTIME_CONFIG_INVALID');
  if (record.schemaVersion !== 1 || record.lastKnown !== true)
    throw new StartupError('RUNTIME_CONFIG_INVALID', `${source}: unsupported runtime status shape`);
  if (typeof record.runId !== 'string' || typeof record.healthState !== 'string')
    throw new StartupError(
      'RUNTIME_CONFIG_INVALID',
      `${source}: runId and healthState are required`,
    );
  if (record.logging !== 'active' && record.logging !== 'unavailable')
    throw new StartupError(
      'RUNTIME_CONFIG_INVALID',
      `${source}: logging must be active or unavailable`,
    );
  const terminal = record.terminal;
  if (terminal !== null && (typeof terminal !== 'object' || terminal === null))
    throw new StartupError(
      'RUNTIME_CONFIG_INVALID',
      `${source}: terminal must be null or an object`,
    );
  const timestamp = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new StartupError('RUNTIME_CONFIG_INVALID', `${source}: ${field} must be a timestamp`);
    return value;
  };
  const optionalHash = (value: unknown, field: string): string | null => value === null ? null : hex64(value, source, field, 'RUNTIME_CONFIG_INVALID');
  const terminalRecord = terminal === null ? null : asObject(terminal, source, 'RUNTIME_CONFIG_INVALID');
  if (terminalRecord && (typeof terminalRecord.code !== 'string' || !terminalRecord.code || typeof terminalRecord.message !== 'string')) throw new StartupError('RUNTIME_CONFIG_INVALID', `${source}: invalid terminal diagnostic`);
  return {
    schemaVersion: 1,
    lastKnown: true,
    runId: record.runId,
    installationId: optionalHash(record.installationId, 'installationId'),
    artifactId: optionalHash(record.artifactId, 'artifactId'),
    locale: record.locale === null ? null : localeId(record.locale, source, 'locale', 'RUNTIME_CONFIG_INVALID'),
    healthState: record.healthState,
    logging: record.logging,
    startedAt: timestamp(record.startedAt, 'startedAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
    terminal:
      terminal === null
        ? null
        : {
            code: terminalRecord!.code as string,
            message: terminalRecord!.message as string,
            at: timestamp(terminalRecord!.at, 'terminal.at'),
          },
  };
}

/**
 * Reads the last-known runtime status for CLI reporting. Returns the decoded
 * snapshot, or null with a reason when it is absent or undecodable; never a
 * live claim.
 */
export function readRuntimeStatus(
  statusPath: string,
  io: { readText?: ReadText } = {},
): { status: RuntimeStatusSnapshot } | { error: string } {
  try {
    const readText = io.readText ?? defaultReadText;
    return {
      status: decodeRuntimeStatus(
        parseJson(readText(statusPath), 'runtime-status.json', 'RUNTIME_CONFIG_INVALID'),
        'runtime-status.json',
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { error: 'no runtime status has been recorded' };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Process-owned runtime telemetry: one JSONL writer/runId plus the atomic
 * runtime-status.json snapshot. Persistence failures are diagnosed once on
 * stderr and never propagate into the coordinator; the original application
 * keeps running without them.
 */
export class RuntimePersistence {
  readonly #sinkBase: EventSink | null;
  readonly #writer: JsonlEventWriter | null;
  readonly #statusPath: string | null;
  readonly #installationId: string | null;
  readonly #startedAt = new Date().toISOString();
  readonly #runId: string;
  #logging: 'active' | 'unavailable';
  #terminal: RuntimeStatusSnapshot['terminal'] = null;
  #diagnosedWriteFailure = false;
  #closed = false;

  constructor(options: { stateRoot: string; installationId: string | null }) {
    this.#installationId = options.installationId;
    const directory = path.join(
      options.stateRoot,
      'logs',
      'runtime',
      options.installationId ?? 'unbound',
    );
    let writer: JsonlEventWriter | null = null;
    try {
      writer = new JsonlEventWriter({ directory });
      this.#logging = 'active';
    } catch (error) {
      this.#logging = 'unavailable';
      console.error(
        `[agyctl localization] LOG_WRITE_FAILED: runtime events are not persisted (${error instanceof Error ? error.message : String(error)}); continuing without a JSONL log`,
      );
    }
    this.#writer = writer;
    this.#runId = writer ? writer.runId : randomUUID();
    this.#sinkBase = writer
      ? createEventSink(writer, {
          component: 'localization-runtime',
          operationId: this.runId,
          installationId: options.installationId ?? undefined,
        })
      : null;
    // Events and the status snapshot must stay relatable: when the writer
    // exists its runId owns the correlation, otherwise this run gets its own.
    this.#statusPath =
      options.installationId === null
        ? null
        : path.join(
            options.stateRoot,
            'installations',
            options.installationId,
            'runtime-status.json',
          );
  }

  get logging(): 'active' | 'unavailable' {
    return this.#logging;
  }

  get runId(): string {
    return this.#runId;
  }

  /** Emits one runtime event; persistence failure degrades to the text log. */
  sink(event: LocalizationEventInput): void {
    if (this.#closed || !this.#sinkBase) return;
    try {
      this.#sinkBase(event);
    } catch (error) {
      this.#logging = 'unavailable';
      if (!this.#diagnosedWriteFailure) {
        this.#diagnosedWriteFailure = true;
        console.error(
          `[agyctl localization] LOG_WRITE_FAILED: runtime events are no longer persisted (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }

  /** Atomically records the last-known runtime snapshot. Best-effort. */
  recordStatus(health: {
    artifactId: string | null;
    locale: string | null;
    healthState: string;
    terminal?: { code: string; message: string } | null;
  }): void {
    if (this.#closed || this.#statusPath === null) return;
    if (health.terminal) {
      this.#terminal = { ...health.terminal, at: new Date().toISOString() };
    } else if (health.healthState !== 'degraded') {
      this.#terminal = null;
    }
    const snapshot: RuntimeStatusSnapshot = {
      schemaVersion: 1,
      lastKnown: true,
      runId: this.runId,
      installationId: this.#installationId,
      artifactId: health.artifactId,
      locale: health.locale,
      healthState: health.healthState,
      logging: this.#logging,
      startedAt: this.#startedAt,
      updatedAt: new Date().toISOString(),
      terminal: this.#terminal,
    };
    const staging = `${this.#statusPath}.staging-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(this.#statusPath), { recursive: true });
      fs.writeFileSync(staging, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(staging, this.#statusPath);
    } catch (error) {
      if (!this.#diagnosedWriteFailure) {
        this.#diagnosedWriteFailure = true;
        console.error(
          `[agyctl localization] runtime status snapshot failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } finally {
      try {
        fs.rmSync(staging, { force: true });
      } catch (error) {
        console.error(
          `[agyctl localization] runtime status staging cleanup failed (${String(error)})`,
        );
      }
    }
  }

  snapshot(health: {
    artifactId: string | null;
    locale: string | null;
    healthState: string;
  }): RuntimeStatusSnapshot {
    return {
      schemaVersion: 1,
      lastKnown: true,
      runId: this.runId,
      installationId: this.#installationId,
      artifactId: health.artifactId,
      locale: health.locale,
      healthState: health.healthState,
      logging: this.#logging,
      startedAt: this.#startedAt,
      updatedAt: '',
      terminal: this.#terminal,
    };
  }

  /** Releases the active log segment so the state directory can be removed. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#writer?.close();
    } catch (error) {
      if (!this.#diagnosedWriteFailure) {
        this.#diagnosedWriteFailure = true;
        console.error(
          `[agyctl localization] runtime log close failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }
}
