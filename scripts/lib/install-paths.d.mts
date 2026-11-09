export declare function agyctlHome(): string;
export declare function backupDir(): string;
export declare function sha256File(filePath: string): string;
export declare function findAsarPath(): string;
export declare function installedTargets(): Array<{
  product: string;
  root: string;
  asarPath: string;
  binaryPath: string;
  executablePath: string;
}>;
