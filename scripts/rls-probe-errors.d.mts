export interface DbErrorSummary {
  code: string;
  severity: string | null;
  message?: string;
  detail?: string;
  hint?: string;
  table?: string;
  schema?: string;
  constraint?: string;
  routine?: string;
  where?: string;
}
export function sanitizeDbText(text: unknown, max?: number): string;
export function dbErrorSummary(error: unknown): DbErrorSummary;
