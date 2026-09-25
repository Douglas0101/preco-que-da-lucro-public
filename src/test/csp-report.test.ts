import { describe, expect, it, vi } from "vitest";
import {
  CSP_REPORT_MAX_PAYLOAD_BYTES,
  CSP_REPORTS_PER_REQUEST_LIMIT,
  cspReportShape,
} from "@/lib/csp-report-payload";
import { Route, handleCspReportPost } from "@/routes/api/csp-report";

const legacyBody = {
  "csp-report": {
    "document-uri": "https://app.example/inicio",
    referrer: "https://app.example/",
    "violated-directive": "script-src 'self'",
    "effective-directive": "script-src",
    "original-policy": "default-src 'self'; script-src 'self'",
    disposition: "report",
    "blocked-uri": "https://cdn.example/x.js",
    "line-number": 12,
    "column-number": 3456,
    "source-file": "https://app.example/assets/app.js",
    "status-code": 200,
    "script-sample": "alert(1)",
  },
};

const reportingBody = [
  {
    age: 1,
    type: "csp-violation",
    url: "https://app.example/inicio",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: "https://app.example/inicio",
      blockedURL: "inline",
      effectiveDirective: "style-src",
      originalPolicy: "default-src 'self'",
      disposition: "report",
      lineNumber: 3,
      columnNumber: 9,
      sourceFile: "https://app.example/assets/app.js",
      statusCode: 0,
      sample: "color:red",
    },
  },
  { age: 2, type: "deprecation", body: { message: "unrelated" } },
];

function post(
  body: string,
  contentType: string | null = "application/csp-report",
  headers: Record<string, string> = {},
): Request {
  const requestHeaders = new Headers();
  if (contentType !== null) requestHeaders.set("content-type", contentType);
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  return new Request("http://127.0.0.1/api/csp-report", {
    method: "POST",
    headers: requestHeaders,
    body,
  });
}

/** Executa o handler com um spy de `console.warn` e devolve status + registros emitidos. */
async function ingest(
  request: Request,
): Promise<{ status: number; response: Response; records: Record<string, unknown>[] }> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  warn.mockClear(); // o spy é reaproveitado entre chamadas do mesmo teste
  const response = await handleCspReportPost({ request });
  return {
    status: response.status,
    response,
    records: warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>),
  };
}

describe("contrato do endpoint de violações de CSP (§20.1)", () => {
  it("aceita o formato legado `application/csp-report` e responde 204 sem corpo", async () => {
    const { status, response, records } = await ingest(post(JSON.stringify(legacyBody)));

    expect(status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(records).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        event: "csp.violation",
        shape: "csp-report",
        effectiveDirective: "script-src",
        violatedDirective: "script-src 'self'",
        blockedUri: "https://cdn.example/x.js",
        documentUri: "https://app.example/inicio",
        sourceFile: "https://app.example/assets/app.js",
        lineNumber: 12,
        columnNumber: 3456,
        disposition: "report",
        sample: "alert(1)",
      },
    ]);
  });

  it("aceita `application/reports+json` e ignora relatórios de outro tipo", async () => {
    const { status, records } = await ingest(
      post(JSON.stringify(reportingBody), "application/reports+json"),
    );

    expect(status).toBe(204);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "csp.violation",
      shape: "reports+json",
      effectiveDirective: "style-src",
      violatedDirective: null,
      blockedUri: "inline",
      documentUri: "https://app.example/inicio",
      sample: "color:red",
    });
  });

  it("aceita media type com charset", async () => {
    const { status } = await ingest(
      post(JSON.stringify(legacyBody), "application/csp-report; charset=utf-8"),
    );

    expect(status).toBe(204);
  });

  it("recusa media type não suportado com 415 e sem lançar", async () => {
    for (const contentType of ["application/json", "text/plain", "", null]) {
      const { status, records } = await ingest(post(JSON.stringify(legacyBody), contentType));

      expect(status).toBe(415);
      expect(records).toEqual([
        expect.objectContaining({
          event: "csp.report_rejected",
          reason: "unsupported_media_type",
        }),
      ]);
    }
  });

  it("cap aplicado por content-length responde 413", async () => {
    const oversized = JSON.stringify({
      "csp-report": { ...legacyBody["csp-report"], "script-sample": "a".repeat(9_000) },
    });
    expect(oversized.length).toBeGreaterThan(CSP_REPORT_MAX_PAYLOAD_BYTES);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleCspReportPost({
      request: {
        headers: new Headers({
          "content-type": "application/csp-report",
          "content-length": String(oversized.length),
        }),
        text: () => Promise.reject(new Error("corpo não deve ser lido acima do cap")),
      } as unknown as Request,
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "csp.report_rejected",
      reason: "payload_too_large",
    });
  });

  it("cap aplicado pelo tamanho real do corpo responde 413", async () => {
    const oversized = JSON.stringify({
      "csp-report": {
        ...legacyBody["csp-report"],
        "source-file": `data:text/plain,${"a".repeat(9_000)}`,
      },
    });
    const { status, records } = await ingest(post(oversized));

    expect(status).toBe(413);
    expect(records[0]).toMatchObject({ reason: "payload_too_large" });
  });

  it("JSON malformado responde 400 sem lançar", async () => {
    const { status, records } = await ingest(post('{"csp-report": '));

    expect(status).toBe(400);
    expect(records[0]).toMatchObject({ event: "csp.report_rejected", reason: "invalid_json" });
  });

  it("JSON válido com forma inesperada responde 400", async () => {
    for (const body of [
      JSON.stringify([legacyBody["csp-report"]]),
      JSON.stringify({ "csp-report": "nope" }),
      JSON.stringify({}),
    ]) {
      const { status, records } = await ingest(post(body));

      expect(status).toBe(400);
      expect(records[0]).toMatchObject({ reason: "invalid_payload" });
    }
  });

  it("arrays sem nenhuma violação de CSP respondem 400", async () => {
    const { status, records } = await ingest(
      post(JSON.stringify([{ type: "deprecation", body: {} }]), "application/reports+json"),
    );

    expect(status).toBe(400);
    expect(records[0]).toMatchObject({ reason: "invalid_payload" });
  });

  it("limita a quantidade de violações registradas por requisição", async () => {
    const many = Array.from({ length: CSP_REPORTS_PER_REQUEST_LIMIT + 2 }, (_, index) => ({
      type: "csp-violation",
      body: { ...reportingBody[0]?.body, blockedURL: `https://cdn.example/${index}.js` },
    }));
    const { status, records } = await ingest(
      post(JSON.stringify(many), "application/reports+json"),
    );

    expect(status).toBe(204);
    const violations = records.filter((record) => record.event === "csp.violation");
    expect(violations).toHaveLength(CSP_REPORTS_PER_REQUEST_LIMIT);
    expect(records.at(-1)).toMatchObject({
      event: "csp.violation_truncated",
      suppressed: 2,
    });
  });

  it("falha inesperada na leitura do corpo responde 400 e nunca 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleCspReportPost({
      request: {
        headers: new Headers({ "content-type": "application/csp-report" }),
        text: () => {
          throw new Error("stream abortado");
        },
      } as unknown as Request,
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "csp.report_rejected",
      reason: "unexpected_error",
    });
  });

  it("registra o handler POST no Route do arquivo de rota", () => {
    const handlers = Route.options.server?.handlers as { POST?: unknown } | undefined;

    expect(handlers?.POST).toBe(handleCspReportPost);
  });
});

describe("media types aceitos", () => {
  it("normaliza caixa, espaços e parâmetros", () => {
    expect(cspReportShape(" Application/CSP-Report ; charset=UTF-8")).toBe("csp-report");
    expect(cspReportShape("application/reports+json")).toBe("reports+json");
    expect(cspReportShape("application/json")).toBeNull();
    expect(cspReportShape(null)).toBeNull();
  });
});
