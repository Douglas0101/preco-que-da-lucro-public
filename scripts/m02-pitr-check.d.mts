export interface PitrParsedArgs {
  plan: boolean;
  minSeconds: number;
  error?: string;
}
export interface PitrPreflight {
  ok: boolean;
  missing: string[];
}
export interface PitrWindowVerdict {
  status: "PASS" | "FAIL" | "DESCONHECIDO";
  detail: string;
  deficit_seconds?: number;
}
export interface PitrRequestInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: unknown;
}
export interface PitrFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type PitrFetch = (url: string, init?: PitrRequestInit) => Promise<PitrFetchResponse>;
export interface PitrCheckResult {
  report: Record<string, unknown>;
  exitCode: number;
}

export const DEFAULT_API_BASE: string;
export const MIN_RETENTION_SECONDS: number;
export const REQUIREMENT: string;
export const SCOPE_NOTES: readonly string[];
export function parseArgs(argv: string[]): PitrParsedArgs;
export function preflight(env: Record<string, string | undefined>): PitrPreflight;
export function redactSecret(text: unknown, secret: string): string;
export function readRetentionSeconds(payload: unknown): number | null;
export function evaluateWindow(
  retentionSeconds: number | null,
  minSeconds?: number,
): PitrWindowVerdict;
export function planReport(minSeconds: number): Record<string, unknown>;
export function skipReport(missing: string[], minSeconds?: number): Record<string, unknown>;
export function checkPitr(options: {
  fetchImpl: PitrFetch;
  apiBase?: string;
  projectId: string;
  apiKey: string;
  minSeconds?: number;
}): Promise<PitrCheckResult>;
