export interface SpendParsedArgs {
  plan: boolean;
  error?: string;
}
export interface SpendPreflight {
  ok: boolean;
  missing: string[];
}
export interface SpendRequestInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: unknown;
}
export interface SpendFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type SpendFetch = (url: string, init?: SpendRequestInit) => Promise<SpendFetchResponse>;
export interface SpendBranchItem {
  name: string | null;
  primary: boolean;
  default: boolean;
  created_at: string | null;
  usage: Record<string, number | null>;
}
export interface SpendBranchesInventory {
  branches: { count: number; primary_count: number; items: SpendBranchItem[] };
  usage_fields_present: string[];
  usage_fields_to_confirm: string[];
}
export interface SpendProjectInventory {
  project_ref_present: boolean;
  org_ref_present: boolean;
  history_retention_seconds: number | null;
}
export interface SpendCheckResult {
  report: Record<string, unknown>;
  exitCode: number;
}

export const BRANCH_USAGE_FIELDS: readonly string[];
export const DEFAULT_API_BASE: string;
export const GUARDRAIL_LIMITS: Record<string, string>;
export const SCOPE_NOTES: readonly string[];
export function parseArgs(argv: string[]): SpendParsedArgs;
export function preflight(env: Record<string, string | undefined>): SpendPreflight;
export function redactSecret(text: unknown, secret: string): string;
export function toHostname(value: unknown): string | null;
export function hostnamesOnly(payload: unknown): string[];
export function projectInventory(payload: unknown): SpendProjectInventory;
export function branchesInventory(payload: unknown): SpendBranchesInventory;
export function planReport(): Record<string, unknown>;
export function skipReport(missing: string[]): Record<string, unknown>;
export function checkSpend(options: {
  fetchImpl: SpendFetch;
  apiBase?: string;
  projectId: string;
  apiKey: string;
}): Promise<SpendCheckResult>;
