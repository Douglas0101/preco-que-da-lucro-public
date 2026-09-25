export interface SnapshotParsedArgs {
  sourceEnv: string;
  outDir: string;
  origin: string;
  outDirExplicit: boolean;
  error?: string;
}
export declare const TRIO_FILENAMES: readonly ["dump.pgc", "dump.pgc.sha256", "metadata.json"];
export interface TrioMetadataInput {
  origin: string;
  sourceEnv: string;
  host: string;
  clientVersion: string;
  serverVersion: string | null;
  inRecovery: string | null;
  sizeBytes: number;
  durationMs: number;
  sha256: string;
  motivo: string;
  startedAt: string;
  finishedAt: string;
}
export function parseArgs(argv: string[]): SnapshotParsedArgs;
export function sha256OfFile(path: string): string;
export function trioPreexists(outDir: string): string[];
export function buildTrioMetadata(input: TrioMetadataInput): Record<string, unknown>;
