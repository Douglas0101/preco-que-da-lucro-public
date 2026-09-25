import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSP_REPORT_MAX_PAYLOAD_BYTES,
  CSP_REPORTS_PER_REQUEST_LIMIT,
} from "@/lib/csp-report-payload";
import { securityHeaders } from "@/lib/security-headers";
import { Route, handleCspReportPost } from "@/routes/api/csp-report";

/**
 * Diretivas de **fonte** (o que de fato restringe a página). Congeladas de propósito: a promoção
 * (report-only → enforcement) não pode acrescentar, remover nem afrouxar nenhuma delas.
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

/** Único acréscimo do §20.1: o canal de coleta, que não autoriza nenhuma origem. */
const REPORTING_DIRECTIVES = ["report-uri /api/csp-report", "report-to csp-endpoint"];

const REPORT_ONLY_POLICY = [...SOURCE_DIRECTIVES, ...REPORTING_DIRECTIVES].join("; ");

/** `default-src 'self'` → `{"default-src": "'self'"}`; sem valor devolve string vazia. */
function directivesOf(policy: string): Record<string, string> {
  return Object.fromEntries(
    policy.split("; ").map((directive) => {
      const separator = directive.indexOf(" ");
      if (separator === -1) return [directive, ""];
      return [directive.slice(0, separator), directive.slice(separator + 1)];
    }),
  );
}

const originalEnforce = process.env.CSP_ENFORCE;

afterEach(() => {
  if (originalEnforce === undefined) delete process.env.CSP_ENFORCE;
  else process.env.CSP_ENFORCE = originalEnforce;
});

describe("política de CSP (§20.1)", () => {
  it("T1: a política enforçada é byte-idêntica à de report-only sem as diretivas de report", () => {
    delete process.env.CSP_ENFORCE;
    const reportOnly = securityHeaders()["content-security-policy-report-only"] ?? "";
    expect(reportOnly).toBe(REPORT_ONLY_POLICY);

    process.env.CSP_ENFORCE = "true";
    const headers = securityHeaders();
    const enforced = headers["content-security-policy"] ?? "";

    // `diff` vazio: as duas políticas só diferem nas diretivas de report, removidas aqui.
    const withoutReporting = reportOnly
      .split("; ")
      .filter((directive) => !REPORTING_DIRECTIVES.includes(directive))
      .join("; ");
    expect(withoutReporting).toBe(SOURCE_DIRECTIVES.join("; "));
    expect(enforced).toBe(withoutReporting);
    expect(enforced).toHaveLength(withoutReporting.length);

    // A promoção troca o header; nunca serve as duas políticas ao mesmo tempo.
    expect(headers["content-security-policy-report-only"]).toBeUndefined();

    // O canal de coleta (diretivas + anúncio do grupo) não entra na resposta enforçada.
    expect(enforced).not.toContain("report-uri");
    expect(enforced).not.toContain("report-to");
    expect(headers["reporting-endpoints"]).toBeUndefined();
  });

  it("T2: sem 'unsafe-inline'/'unsafe-eval', sem host novo e sem `data:` em script-src", () => {
    delete process.env.CSP_ENFORCE;
    const policy = securityHeaders()["content-security-policy-report-only"] ?? "";
    const directives = directivesOf(policy);

    // Lista fechada: qualquer diretiva ou origem nova (host novo) quebra esta comparação.
    expect(Object.keys(directives)).toEqual([
      ...SOURCE_DIRECTIVES.map((directive) => directive.slice(0, directive.indexOf(" "))),
      "report-uri",
      "report-to",
    ]);
    expect(directives).toEqual(directivesOf(REPORT_ONLY_POLICY));

    // Travas do AGENTS.md: nenhum caminho de escape de script/estilo.
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|strict-dynamic/);
    // Nonce é decisão explícita do plano §20.1 (CSP estática): não existe `nonce-…` nem `'self'` frouxo.
    expect(policy).not.toContain("nonce-");
    expect(policy).not.toContain("*");

    expect(directives["script-src"]).toBe("'self'");
    expect(directives["default-src"]).toBe("'self'");
    expect(directives["object-src"]).toBe("'none'");
    expect(directives["base-uri"]).toBe("'self'");
    expect(directives["frame-ancestors"]).toBe("'none'");
    expect(directives["form-action"]).toBe("'self'");
    expect(directives["style-src"]).toBe("'self'");

    // `data:` só é permitido onde o plano o autoriza (imagem e fonte), nunca em script.
    for (const name of ["script-src", "default-src", "object-src", "base-uri", "form-action"]) {
      expect(directives[name]).not.toContain("data:");
    }
    expect(directives["img-src"]).toBe("'self' data: https:");
    expect(directives["font-src"]).toBe("'self' data:");
    expect(directives["connect-src"]).toBe("'self' https:");
  });

  it("T3: o canal de coleta segue best-effort, com cap de 8 KiB/10 violações", async () => {
    delete process.env.CSP_ENFORCE;
    const policy = securityHeaders()["content-security-policy-report-only"] ?? "";
    // O caminho anunciado pela política precisa ter handler publicado: um `report-uri` órfão
    // tornaria a coleta (e o gate de "relatório limpo") silenciosamente vazia.
    expect(policy).toContain("report-uri /api/csp-report");
    const handlers = Route.options.server?.handlers as { POST?: unknown } | undefined;
    expect(handlers?.POST).toBeTypeOf("function");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // (a) Acima do cap: 413 sem ler o corpo — trabalho limitado por requisição.
    const overCap = {
      headers: new Headers({
        "content-type": "application/csp-report",
        "content-length": String(CSP_REPORT_MAX_PAYLOAD_BYTES + 1),
      }),
      text: () => Promise.reject(new Error("corpo não deve ser lido acima do cap")),
    } as unknown as Request;
    const rejected = await handleCspReportPost({ request: overCap });
    expect(rejected.status).toBe(413);
    expect(rejected.headers.get("cache-control")).toBe("no-store");

    // (b) Lote acima do limite: registra no máximo 10 violações e sinaliza o truncamento.
    warn.mockClear();
    const violations = Array.from({ length: CSP_REPORTS_PER_REQUEST_LIMIT + 5 }, (_, index) => ({
      type: "csp-violation",
      body: {
        documentURL: `https://app.example/pagina-${index}`,
        blockedURL: "https://cdn.example/blocked.js",
        effectiveDirective: "script-src",
        disposition: "report",
      },
    }));
    const accepted = await handleCspReportPost({
      request: new Request("http://127.0.0.1/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/reports+json" },
        body: JSON.stringify(violations),
      }),
    });
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("cache-control")).toBe("no-store");

    const records = warn.mock.calls.map(
      (call) => JSON.parse(String(call[0])) as Record<string, unknown>,
    );
    expect(records.filter((record) => record.event === "csp.violation")).toHaveLength(
      CSP_REPORTS_PER_REQUEST_LIMIT,
    );
    expect(records.filter((record) => record.event === "csp.violation_truncated")).toEqual([
      expect.objectContaining({ suppressed: 5 }),
    ]);
  });
});
