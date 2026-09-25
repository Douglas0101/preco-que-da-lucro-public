export interface SnapshotTrioVerdict {
  ok: boolean;
  createdAtMs: number | null;
  reasons: string[];
}
export interface SnapshotFreshness {
  status: "PASS" | "FAIL" | "DESCONHECIDO";
  source: string;
  detail: string;
}
export function evaluateSnapshotDir(dirPath: string, nowMs: number): SnapshotTrioVerdict;
export function checkSnapshotFromRoot(rootDir: string, nowMs: number): SnapshotFreshness;
