import type { HostReceipt } from './contracts.js';

export interface AsarEngineLike {
  validateArchive(archivePath: string): void;
  patchArchive(source: string, destination: string, replacements: Record<string, Buffer>): void;
  copyUnpacked(source: string, destination: string): void;
  extractFile(archivePath: string, relative: string): Buffer;
}

export interface PreparedFeature {
  preload: string;
  files: Record<string, Buffer>;
  receiptState?: HostReceipt['features']['capsule'] | HostReceipt['features']['localization'];
}

export interface HostFeature<Input> {
  validate(input: Input): void;
  qualify?(input: Input, context: { originalHash: string; executablePath?: string }): {
    profileStatus?: string;
    warnings: Array<{ code: string; message: string }>;
  };
  compose(input: Input, context: { originalPath: string; engine: AsarEngineLike }): PreparedFeature;
}
