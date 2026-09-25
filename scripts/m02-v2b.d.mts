export interface V2bPlanStep {
  id: string;
  what: string;
  expected?: string;
  on_fail: string;
}
export interface V2bParsedArgs {
  plan?: boolean;
  error?: string;
}
export interface V2bPreflightResult {
  ok: boolean;
  missing: string[];
}
export function parseArgs(argv: string[]): V2bParsedArgs;
export function preflight(env: Record<string, string | undefined>): V2bPreflightResult;
export function preflightGuidance(missing: string[]): string;
export function buildPlan(ctx: Record<string, string>): V2bPlanStep[];
export function maskUrl(url: string): string;
export function utcDate(now?: Date): string;
/** Entradas de `drizzle/meta/_journal.json` (fonte canônica da contagem esperada
 * do passo `migrate`); `rootDir` default = raiz do repo (posição do módulo).
 * Fail-closed: journal ausente/ilegível/sem entradas lança erro acionável. */
export function expectedJournalCount(rootDir?: string): number;
