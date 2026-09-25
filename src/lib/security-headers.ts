// Extraído de src/start.ts para quebrar um ciclo de módulos no SSR:
// src/server.ts importava deste arquivo, que executa createStart() no escopo do módulo,
// o que fazia o binding `ssr_exports` desaparecer em runtime (ver docs/evidence/p0-port-2026-09-13.md §7).

const CSP_REPORT_PATH = "/api/csp-report";
const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * Diretivas de fonte: o que de fato restringe a página. Congeladas — a promoção de
 * `report-only` para enforcement não acrescenta, remove nem afrouxa nenhuma delas
 * (nenhum `'unsafe-inline'`, nenhum host novo, nenhum nonce: ver AGENTS.md e plano §20.1).
 */
const SOURCE_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self' https:",
];

/**
 * §20.1 — canal de coleta, exclusivo da janela report-only. `report-uri` é o canal legado
 * (`application/csp-report`), aceito por todos os motores; `report-to` usa o grupo declarado em
 * `reporting-endpoints` (Reporting API, `application/reports+json`). Nenhuma fonte (`*-src`) é
 * afetada por eles.
 */
const REPORTING_DIRECTIVES = [`report-uri ${CSP_REPORT_PATH}`, `report-to ${CSP_REPORT_GROUP}`];

/**
 * `CSP_ENFORCE=true` promove a política: a resposta enforçada carrega **exatamente** as diretivas de
 * fonte, byte a byte iguais às do modo report-only — o canal de coleta (as duas diretivas de report
 * e o header `reporting-endpoints`) pertence à janela de soak e sai da resposta enforçada.
 */
export function securityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
  };
  if (process.env.CSP_ENFORCE === "true") {
    headers["content-security-policy"] = SOURCE_DIRECTIVES.join("; ");
  } else {
    headers["content-security-policy-report-only"] = [
      ...SOURCE_DIRECTIVES,
      ...REPORTING_DIRECTIVES,
    ].join("; ");
    headers["reporting-endpoints"] = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
  }
  if (process.env.NODE_ENV === "production") {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}
