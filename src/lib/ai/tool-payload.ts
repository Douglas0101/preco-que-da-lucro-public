/**
 * Sanitizador do input de tools persistido em `tool_executions.input` (§14.3).
 *
 * O input vem do modelo (dado não confiável) e é gravado em jsonb. Aplica
 * limites de tamanho/profundidade e redação por chave sensível estrita.
 * Não reutiliza o `SENSITIVE_KEY` do logger: aquele predicado casa por
 * substring e apagaria campos de domínio legítimos (ex.: "pricing").
 */

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 8_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_KEY_LENGTH = 120;
const MAX_DEPTH = 8;

/**
 * Match estrito: só a chave inteira redige, ignorando caixa e separadores
 * (`api_key` → `apikey`). `authorization_ref` ou `access_token` não casam.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "apikey",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeString(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0xd800 && code <= 0xdfff) ||
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    if (sanitized.length + character.length > MAX_STRING_LENGTH) break;
    sanitized += character;
    if (sanitized.length === MAX_STRING_LENGTH) break;
  }
  return sanitized;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, entry]) => {
          const safeKey = key.slice(0, MAX_KEY_LENGTH);
          return [
            safeKey,
            SENSITIVE_KEYS.has(normalizeKey(safeKey)) ? REDACTED : sanitizeValue(entry, depth + 1),
          ];
        }),
    );
  }
  return null;
}

/**
 * Retorna o input pronto para jsonb, ou `null` quando não é um objeto JSON —
 * o chamador usa `null` para `JSON.parse` inválido e payload não-objeto.
 */
export function sanitizeToolInput(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const sanitized = sanitizeValue(value, 0);
  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) return null;
  return sanitized as Record<string, unknown>;
}
