import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withHttpRequestSpan } from "@/instrumentation/http-request-span";
import { redactSqlText } from "@/instrumentation/sql-redactor";
import { startDatabaseQuerySpan, withSpan } from "@/instrumentation/telemetry";
import { withBffSpan } from "@/middleware/request-context";

/**
 * §19.4 — Sanitização de trace.
 *
 * A garantia até aqui era *por construção*: o conjunto de atributos é fechado
 * e nenhum call site passa header, DB URL ou prompt. Construção sem asserção é
 * cobertura aparente — o mesmo defeito que o `m02:secrets-audit` já teve. Este
 * arquivo é a prova negativa: ele **exercita os caminhos reais**, recolhe os
 * spans que eles emitem e verifica, atributo a atributo, que nada sensível
 * chegou lá.
 *
 * Dois verificadores, porque capturam coisas diferentes:
 * 1. runtime — valores que só existem em execução (o que um call site injeta);
 * 2. namespace — a chave tem de pertencer a um prefixo previsto, para que uma
 *    chave nova tipo `auth.header.authorization` não passe despercebida só
 *    porque ninguém pensou nela.
 *
 * A descoberta vazia reprova: se os caminhos deixarem de emitir span, o teste
 * tem de falhar, não ficar verde sem ter olhado nada.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

/** §19.4 lista cinco proibições fechadas: token, senha, DB URL, prompt, PII. */
const FORBIDDEN_IN_VALUE: Array<{ re: RegExp; what: string }> = [
  { re: /postgres(?:ql)?:\/\/\S+/i, what: "DB URL" },
  { re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i, what: "bearer token" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, what: "e-mail" },
  { re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, what: "CPF" },
  {
    // Só literal entre aspas: o SQL redigido termina em `= ?`, que é exatamente
    // o que queremos ver, e não pode ser confundido com credencial vazando.
    re: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{4,}['"]/i,
    what: "literal de credencial",
  },
  { re: /\b[0-9a-f]{40,}\b/i, what: "hash longo (possível segredo)" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "chave privada" },
];

/** Chaves fora destes prefixos são um vazamento por design (S4036 do Sonar
 * resolve binário via PATH; aqui a falha análoga é sair da fronteira prevista). */
const ALLOWED_KEY_PREFIXES = ["app.", "db.", "http.", "url.", "ai.", "gen_ai.", "otel."];

const FORBIDDEN_IN_KEY =
  /authorization|bearer|cookie|password|passwd|secret|api[_-]?key|private[_-]?key|\btoken\b/i;

interface AttributeSource {
  spanName: string;
  key: string;
  value: unknown;
}

function collectAttributes(): AttributeSource[] {
  const out: AttributeSource[] = [];
  for (const span of exporter.getFinishedSpans()) {
    for (const [key, value] of Object.entries(span.attributes)) {
      out.push({ spanName: span.name, key, value });
    }
  }
  return out;
}

/** Percorre todos os caminhos que emitem span na app real. */
async function exerciseRealPaths(): Promise<void> {
  await withHttpRequestSpan(
    {
      "http.request.method": "POST",
      // Caminho com traço de PII: o span grava `url.path`, nunca a query string.
      "url.path": "/_serverFn/dashboard",
      "app.correlation_id": "60000000-0000-4000-8000-000000000006",
    },
    async () => {
      await withBffSpan("requireDatabaseAuth", "60000000-0000-4000-8000-000000000006", async () => {
        const raw = "SELECT id FROM app_users WHERE email = 'douglas@example.com' LIMIT 10";
        const span = startDatabaseQuerySpan("SELECT", redactSqlText(raw));
        span.end();
        await withSpan(
          "service.sanitization.probe",
          {
            "app.tenant_id": "70000000-0000-4000-8000-000000000007",
            "app.correlation_id": "60000000-0000-4000-8000-000000000006",
          },
          async () => "ok",
        );
      });
    },
  );
}

describe("§19.4 — nenhum atributo de span carrega token, senha, DB URL, prompt ou PII", () => {
  it("exercita os caminhos reais e recolhe spans (descoberta não vazia)", async () => {
    await exerciseRealPaths();

    const spans = exporter.getFinishedSpans();
    const names = new Set(spans.map((span) => span.name));

    // Controle negativo da própria ferramenta: se a descoberta vier vazia, o
    // teste abaixo passaria sem olhar nada. Exigimos os caminhos nomeados.
    expect(names).toEqual(
      new Set(["http.request", "bff.request", "SELECT", "service.sanitization.probe"]),
    );
    expect(collectAttributes().length).toBeGreaterThan(0);
  });

  it("nenhum valor de atributo casa uma forma sensível da §19.4", async () => {
    await exerciseRealPaths();

    const offenders = collectAttributes().flatMap(({ spanName, key, value }) => {
      if (typeof value !== "string") return [];
      return FORBIDDEN_IN_VALUE.filter((rule) => rule.re.test(value)).map(
        (rule) => `${spanName}.${key} → ${rule.what}`,
      );
    });

    expect(offenders).toEqual([]);
  });

  it("nenhuma chave de atributo nomeia um segredo", async () => {
    await exerciseRealPaths();

    const offenders = collectAttributes()
      .filter(({ key }) => FORBIDDEN_IN_KEY.test(key))
      .map(({ spanName, key }) => `${spanName}.${key}`);

    expect(offenders).toEqual([]);
  });

  it("toda chave pertence a um namespace previsto", async () => {
    await exerciseRealPaths();

    const offenders = collectAttributes()
      .filter(({ key }) => !ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
      .map(({ spanName, key }) => `${spanName}.${key}`);

    expect(offenders).toEqual([]);
  });

  it("o SQL redigido não guarda o literal do e-mail, mesmo dentro do span", async () => {
    await exerciseRealPaths();

    const dbSpan = exporter.getFinishedSpans().find((span) => span.name === "SELECT");
    expect(dbSpan).toBeDefined();

    const text = dbSpan?.attributes["db.query.text"];
    expect(typeof text).toBe("string");
    expect(text as string).not.toContain("douglas@example.com");
    expect(text as string).not.toContain("'douglas");
  });
});
