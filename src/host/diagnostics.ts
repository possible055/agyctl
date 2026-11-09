import type { ToolingEventInput } from './contracts.js';

export interface HostWarning {
  code: 'CLEANUP_FAILED' | 'LOG_WRITE_FAILED';
  message: string;
  path?: string;
}

interface DiagnosticIo {
  logEvent?: (event: ToolingEventInput) => void;
  log?: (message: string) => void;
}

const operations = new WeakMap<object, { committed: boolean; warnings: HostWarning[] }>();

export function operationIo<T extends DiagnosticIo>(io: T): T {
  const scoped = { ...io };
  operations.set(scoped, { committed: false, warnings: [] });
  return scoped;
}

export function markCommitted(io: DiagnosticIo): void {
  const operation = operations.get(io);
  if (operation) operation.committed = true;
}

export function operationWarnings(io: DiagnosticIo): HostWarning[] {
  return operations.get(io)?.warnings ?? [];
}

function retainWarning(io: DiagnosticIo, warning: HostWarning, failure?: unknown): void {
  operations.get(io)?.warnings.push(warning);
  if (failure instanceof Error) {
    const error = failure as Error & { warnings?: HostWarning[] };
    error.warnings = [...(error.warnings ?? []), warning];
  }
}

export function emitEvent(io: DiagnosticIo, event: ToolingEventInput): void {
  try {
    io.logEvent?.(event);
  } catch (error) {
    if (!operations.get(io)?.committed) throw error;
    retainWarning(io, { code: 'LOG_WRITE_FAILED', message: String(error) });
    console.error(`LOG_WRITE_FAILED: archive committed; ${String(error)}`);
  }
}

export function emitFailure(io: DiagnosticIo, event: ToolingEventInput, failure: unknown): void {
  try {
    io.logEvent?.(event);
  } catch (error) {
    retainWarning(io, { code: 'LOG_WRITE_FAILED', message: String(error) }, failure);
    console.error(`LOG_WRITE_FAILED: preserving the original operation error; ${String(error)}`);
  }
}

export function reportWarning(io: DiagnosticIo, warning: HostWarning, failure?: unknown): void {
  retainWarning(io, warning, failure);
  const event: ToolingEventInput = {
    level: 'warn', stage: 'host.cleanup', event: 'warning', result: 'warn',
    code: warning.code, detail: warning.message,
  };
  if (failure !== undefined) emitFailure(io, event, failure);
  else emitEvent(io, event);
  if (!io.logEvent) console.error(`${warning.code}: ${warning.message}`);
}

export function finishCleanup(io: DiagnosticIo, location: string, cleanup: () => void, failure?: unknown): void {
  try {
    cleanup();
  } catch (error) {
    if (failure === undefined && !operations.get(io)?.committed) throw error;
    reportWarning(io, {
      code: 'CLEANUP_FAILED', path: location,
      message: `${operations.get(io)?.committed ? 'Archive committed' : 'Operation failed'}; cleanup failed at ${location}: ${String(error)}`,
    }, failure);
  }
}

export function reportCommittedLog(io: DiagnosticIo, message: string): void {
  try {
    io.log?.(message);
  } catch (error) {
    retainWarning(io, { code: 'LOG_WRITE_FAILED', message: String(error) });
    console.error(`LOG_WRITE_FAILED: archive committed; ${String(error)}`);
  }
}
