const REDACTED = "[REDACTED]";
// §19.4: "pricing"/"ai_model_pricing" keep AI model price config out of logs
// (AI_MODEL_PRICING_JSON and any object carrying price tables).
const SENSITIVE_KEY =
  /(?:authorization|cookie|token|secret|password|passwd|database_url|connection|string|hash|email|phone|cpf|cnpj|pricing|ai_model_pricing)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s]+/gi;
const DATABASE_URL = /\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s"']+/gi;
const SECRET_ASSIGNMENT = /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*[^\s&;,]+/gi;

function redactString(value: string): string {
  return value
    .replace(DATABASE_URL, REDACTED)
    .replace(BEARER, REDACTED)
    .replace(SECRET_ASSIGNMENT, REDACTED)
    .replace(EMAIL, REDACTED);
}

export function redactLogValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value).slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactLogValue(item, "", depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactLogValue(entryValue, entryKey, depth + 1),
      ]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  return "[UNSERIALIZABLE]";
}

export function logJson(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const record = JSON.stringify(
    redactLogValue({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    }),
  );
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}
