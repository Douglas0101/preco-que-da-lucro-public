// rls-probe-errors.mjs — FAIL-LOUD sanitizado da sonda H-07 (Fase A3, 2026-09-08).
//
// Motivação (C-02A): o resumo anterior suprimia a mensagem do banco por
// inteiro, de modo que o 42P01 da fase PROBE ficou DESCONHECIDO (relação
// acusada invisível) e o diagnóstico seguinte falhou antes de conectar.
// Este módulo torna o erro COMPLETO e visível (code, severity, message,
// detail, hint, table/schema/constraint/routine/where) MAS continua
// redigindo qualquer valor que possa ser URL/credencial/host:
//
//   - URLs postgres(ql)://... -> <url-redacted>
//   - emails (marcadores @preco-que-da.test incluídos) -> <email-redacted>
//   - hosts/endpoints Neon (ep-*.neon.tech, ep-<id>) -> <host-mascarado>
//   - password=... -> password=<redacted>
//
// Nomes de relação (products, users, tenant_memberships, profiles,
// app_private.*) são identificadores — NUNCA redigidos. É exatamente o que
// faltou para responder "QUAL relação o PG acusa?" (Fase A1).
//
// Sem efeitos colaterais na importação: pode ser testado por vitest sem
// abrir socket.

const URL_PATTERN = /(postgres(ql)?|postgresql):\/\/\S+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NEON_HOST_PATTERN = /[A-Za-z0-9-]+\.neon\.tech/gi;
const ENDPOINT_PATTERN = /ep-[A-Za-z0-9-]+/g;
const PASSWORD_PATTERN = /password\s*=\s*\S+/gi;

/** Redige segredos/URIs de um texto livre, preservando identificadores SQL. */
export function sanitizeDbText(text, max = 500) {
  const raw = text === null || text === undefined ? "" : String(text);
  const redacted = raw
    .replace(URL_PATTERN, "<url-redacted>")
    .replace(PASSWORD_PATTERN, "password=<redacted>")
    .replace(NEON_HOST_PATTERN, "<host-mascarado>")
    .replace(ENDPOINT_PATTERN, "<endpoint-mascarado>")
    .replace(EMAIL_PATTERN, "<email-redacted>");
  return redacted.slice(0, max);
}

/** Resumo FAIL-LOUD de erro do driver pg: tudo visível, segredos redigidos. */
export function dbErrorSummary(error) {
  if (error === null || error === undefined) {
    return { code: "DESCONHECIDO", severity: null };
  }
  const summary = {
    code: error?.code ?? "DESCONHECIDO",
    severity: error?.severity ?? null,
  };
  // Mensagem completa (sanitizada): contém a relação do 42P01.
  if (error?.message !== undefined) summary.message = sanitizeDbText(error.message);
  // Campos estruturados do erro PG: identificadores, nunca segredos.
  for (const field of ["detail", "hint", "table", "schema", "constraint", "routine", "where"]) {
    if (error?.[field] !== undefined && error?.[field] !== null) {
      summary[field] = sanitizeDbText(error[field]);
    }
  }
  return summary;
}
