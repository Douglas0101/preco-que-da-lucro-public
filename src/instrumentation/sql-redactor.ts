/**
 * Redator de SQL para telemetria (§19.3): remove literais e comentários antes
 * que qualquer texto de query vire atributo de span.
 *
 * Contrato:
 * - `$1`, `$2`, ... (placeholders) são preservados — `values` nunca é anexado;
 * - literais entre aspas simples (`''` escapado; barra invertida escapa apenas
 *   em `E'...'`/`e'...'`, como em `standard_conforming_strings=on`) e
 *   dollar-quoted (`$tag$...$tag$`) viram `?`;
 * - identificadores entre aspas duplas são preservados byte a byte (inclusive
 *   espaços internos);
 * - comentários `--` (até `\n` ou `\r`) e `/* *\/` (aninhados) são removidos;
 * - o resultado é normalizado (espaços colapsados **fora** dos identificadores)
 *   e truncado em `maxLength` caracteres, com sufixo `...`;
 * - a operação (`SELECT`, `INSERT`, ...) é derivada do texto redigido e cai
 *   para `QUERY` quando não reconhecida.
 */

export const SQL_REDACTION_MAX_LENGTH = 256;
const TRUNCATION_SUFFIX = "...";
const OPERATION_PROBE_LENGTH = 64;

const SQL_OPERATIONS = new Set([
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "CLOSE",
  "CLUSTER",
  "COMMENT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DEALLOCATE",
  "DECLARE",
  "DELETE",
  "DISCARD",
  "DO",
  "DROP",
  "EXECUTE",
  "EXPLAIN",
  "FETCH",
  "GRANT",
  "IMPORT",
  "INSERT",
  "LISTEN",
  "LOAD",
  "LOCK",
  "MERGE",
  "MOVE",
  "NOTIFY",
  "PREPARE",
  "REFRESH",
  "REINDEX",
  "RELEASE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SELECT",
  "SET",
  "SHOW",
  "START",
  "TABLE",
  "TRUNCATE",
  "UNLISTEN",
  "UPDATE",
  "VACUUM",
  "VALUES",
  "WITH",
]);

function normalizeLimit(maxLength: number): number {
  if (!Number.isFinite(maxLength) || maxLength < TRUNCATION_SUFFIX.length + 1) {
    return SQL_REDACTION_MAX_LENGTH;
  }
  return Math.floor(maxLength);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

/** Consome `'...'`. Em literal comum (`standard_conforming_strings=on`, o
 * default do PostgreSQL) só `''` escapa: a barra invertida é um caractere
 * literal. Tratá-la como escape fazia o literal engolir a aspa seguinte e
 * emitir o conteúdo do literal vizinho em `db.query.text`.
 * `backslashEscapes` liga a semântica de `E'...'`/`e'...'`. */
function consumeSingleQuoted(sql: string, start: number, backslashEscapes: boolean): number {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === "\\" && index + 1 < sql.length) {
      index += 2;
      continue;
    }
    if (char === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/** Reconhece o prefixo `E'...'`/`e'...'` (string com escape por barra
 * invertida). O `E` só conta como prefixo no início de uma palavra —
 * `true'...'` não é uma string com escape. */
function hasEscapeStringPrefix(sql: string, quoteIndex: number): boolean {
  const prefix = sql[quoteIndex - 1];
  if (prefix !== "e" && prefix !== "E") return false;
  const before = quoteIndex >= 2 ? sql[quoteIndex - 2] : undefined;
  return before === undefined || !/[A-Za-z0-9_$]/.test(before);
}

function consumeDoubleQuoted(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"') {
      if (sql[index + 1] === '"') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function consumeLineComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
  return index;
}

function consumeBlockComment(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
      continue;
    }
    if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return sql.length;
}

/** Reconhece o delimitador de dollar-quote (`$$` ou `$tag$`); `$1` não casa
 * porque o tag não pode começar com dígito. */
function dollarQuoteDelimiter(sql: string, start: number): string | undefined {
  let index = start + 1;
  while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index]!)) index += 1;
  if (index >= sql.length || sql[index] !== "$") return undefined;
  const tag = sql.slice(start + 1, index);
  if (tag.length > 0 && !/^[A-Za-z_]/.test(tag)) return undefined;
  return sql.slice(start, index + 1);
}

function consumeDollarQuoted(sql: string, start: number, delimiter: string): number {
  const end = sql.indexOf(delimiter, start + delimiter.length);
  return end < 0 ? sql.length : end + delimiter.length;
}

/** Redige um SQL: literais/comentários fora, espaços colapsados fora dos
 * identificadores entre aspas duplas, truncado. */
export function redactSqlText(sql: string, maxLength = SQL_REDACTION_MAX_LENGTH): string {
  if (typeof sql !== "string" || sql.length === 0) return "";
  const limit = normalizeLimit(maxLength);
  const segments: Array<{ text: string; verbatim: boolean }> = [];
  const push = (text: string, verbatim = false): void => {
    if (text === "") return;
    const last = segments[segments.length - 1];
    if (last && last.verbatim === verbatim) {
      last.text += text;
      return;
    }
    segments.push({ text, verbatim });
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      index = consumeSingleQuoted(sql, index, hasEscapeStringPrefix(sql, index));
      push("?");
      continue;
    }
    if (char === '"') {
      const end = consumeDoubleQuoted(sql, index);
      push(sql.slice(index, end), true);
      index = end;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      index = consumeLineComment(sql, index);
      push(" ");
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index = consumeBlockComment(sql, index);
      push(" ");
      continue;
    }
    if (char === "$") {
      const delimiter = dollarQuoteDelimiter(sql, index);
      if (delimiter) {
        index = consumeDollarQuoted(sql, index, delimiter);
        push("?");
        continue;
      }
    }
    push(char);
    index += 1;
  }
  const normalized = segments
    .map((segment) => (segment.verbatim ? segment.text : segment.text.replace(/\s+/g, " ")))
    .join("")
    .trim();
  return truncate(normalized, limit);
}

/** Primeira palavra do SQL redigido, em maiúsculas (semconv `db.operation.name`). */
export function normalizeSqlOperation(sql: string | undefined): string {
  if (typeof sql !== "string" || sql.trim() === "") return "QUERY";
  const head = redactSqlText(sql, OPERATION_PROBE_LENGTH);
  const match = /^[A-Za-z][A-Za-z0-9_]*/.exec(head);
  if (!match) return "QUERY";
  const operation = match[0].toUpperCase();
  return SQL_OPERATIONS.has(operation) ? operation : "QUERY";
}
