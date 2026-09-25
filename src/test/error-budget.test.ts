import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_TOLERANCE_RATE,
  buildReport,
  classifyRecord,
  parseArgs,
  parseRecords,
  parseWindow,
  renderReport,
  type CodeCount,
  type EventRecord,
} from "../../scripts/obs/error-budget";

const DAY_MS = 86_400_000;

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), "src/test/fixtures/error-budget", name), "utf8");
}

function record(partial: Partial<EventRecord>): EventRecord {
  return {
    timestamp: Date.parse("2026-09-13T12:00:00.000Z"),
    event: "request.failed",
    code: null,
    status: null,
    correlationId: null,
    pathname: null,
    state: null,
    ...partial,
  };
}

function codeEntry(
  report: ReturnType<typeof buildReport>,
  bucket: CodeCount["bucket"],
  code: string,
): CodeCount | undefined {
  return report.codes.find((entry) => entry.bucket === bucket && entry.code === code);
}

describe("parseWindow", () => {
  it("converte s|m|h|d", () => {
    expect(parseWindow("3600s")).toBe(3_600_000);
    expect(parseWindow("90m")).toBe(5_400_000);
    expect(parseWindow("24h")).toBe(DAY_MS);
    expect(parseWindow("7d")).toBe(7 * DAY_MS);
  });

  it("recusa janela vazia, zero ou unidade desconhecida", () => {
    expect(() => parseWindow("7w")).toThrow(/--window inválida/);
    expect(() => parseWindow("0d")).toThrow(/--window inválida/);
    expect(() => parseWindow("")).toThrow(/--window inválida/);
  });
});

describe("parseArgs", () => {
  it("aplica defaults e deriva o caminho da evidência da janela", () => {
    const args = parseArgs([]);
    expect(args.window).toBe("7d");
    expect(args.minRequests).toBe(100);
    expect(args.baseline).toBeNull();
    expect(args.out).toBe("docs/evidence/error-budget-7d.md");
  });

  it("aceita input, baseline e out explícitos", () => {
    const args = parseArgs([
      "--input=fixture.jsonl",
      "--window=24h",
      "--min-requests=10",
      "--baseline=docs/evidence/m06-baseline.md",
      "--out=/tmp/error-budget.md",
    ]);
    expect(args.input).toBe("fixture.jsonl");
    expect(args.windowMs).toBe(DAY_MS);
    expect(args.minRequests).toBe(10);
    expect(args.baseline).toBe("docs/evidence/m06-baseline.md");
    expect(args.out).toBe("/tmp/error-budget.md");
  });

  it("falha fechado em argumento desconhecido ou N inválido", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/argumento desconhecido/);
    expect(() => parseArgs(["--min-requests=0"])).toThrow(/inteiro positivo/);
    expect(() => parseArgs(["--window="])).toThrow(/não pode ser vazio/);
  });
});

describe("parseRecords", () => {
  it("ignora linhas vazias/lixo sem timestamp e conta o descarte", () => {
    const raw = [
      '{"timestamp":"2026-09-13T12:00:00.000Z","event":"request.completed","status":200}',
      "",
      "not-json",
      '{"event":"request.completed"}',
      '{"timestamp":"2026-09-13T12:00:00.000Z"}',
    ].join("\n");
    const parsed = parseRecords(raw);
    expect(parsed.lines).toBe(4);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.skipped).toBe(3);
  });
});

describe("classifyRecord", () => {
  it("exclui 4xx de validação/auth, quota de IA e cliente", () => {
    for (const code of [
      "VALIDATION_ERROR",
      "AUTHENTICATION_ERROR",
      "AUTHORIZATION_ERROR",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMIT",
      "AI_QUOTA",
    ]) {
      expect(classifyRecord(record({ code }), new Set()).disposition).toBe("excluded");
    }
    expect(
      classifyRecord(record({ event: "request.completed", status: 400, code: null }), new Set())
        .disposition,
    ).toBe("excluded");
  });

  it("classifica IA transitória por code e por vínculo de chat", () => {
    expect(classifyRecord(record({ code: "AI_TIMEOUT" }), new Set()).disposition).toBe(
      "ai_transient",
    );
    expect(
      classifyRecord(
        record({ code: "DEPENDENCY_ERROR", correlationId: "chat-1" }),
        new Set(["chat-1"]),
      ).disposition,
    ).toBe("ai_transient");
    expect(
      classifyRecord(record({ code: "DEPENDENCY_ERROR", pathname: "/api/chat" }), new Set())
        .disposition,
    ).toBe("ai_transient");
  });

  it("manda DEPENDENCY_ERROR não-chat, DATABASE_ERROR, INTERNAL_ERROR e 5xx para server_fault", () => {
    expect(classifyRecord(record({ code: "DEPENDENCY_ERROR" }), new Set()).disposition).toBe(
      "server_fault",
    );
    expect(classifyRecord(record({ code: "DATABASE_ERROR" }), new Set()).disposition).toBe(
      "server_fault",
    );
    expect(classifyRecord(record({ code: "INTERNAL_ERROR" }), new Set()).disposition).toBe(
      "server_fault",
    );
    expect(
      classifyRecord(record({ event: "request.completed", status: 503, code: null }), new Set())
        .disposition,
    ).toBe("server_fault");
  });

  it("classifica estados financeiros e timeouts de IA", () => {
    expect(
      classifyRecord(record({ event: "app.financial.states", state: "invalid" }), new Set())
        .disposition,
    ).toBe("financial_critical");
    expect(
      classifyRecord(record({ event: "app.financial.states", state: "incomplete" }), new Set())
        .disposition,
    ).toBe("monitored");
    expect(classifyRecord(record({ event: "app.ai.timeouts" }), new Set()).disposition).toBe(
      "monitored",
    );
  });

  it("trata code ausente como falha de servidor (fail-closed)", () => {
    expect(classifyRecord(record({ code: null }), new Set()).disposition).toBe("server_fault");
  });
});

describe("buildReport — janela e agregação", () => {
  it("recorta a janela pelo último timestamp e agrega por code", () => {
    const args = parseArgs(["--window=7d", "--min-requests=10"]);
    const report = buildReport(fixture("basic-7d.jsonl"), args, "fixture");

    expect(report.requests.total).toBe(11);
    expect(report.requests.completed).toBe(4);
    expect(report.requests.failed).toBe(7);
    expect(report.requests.chat).toBe(3);
    expect(report.window.end).toBe("2026-09-13T11:59:00.000Z");
    expect(report.window.start).toBe("2026-09-06T11:59:00.000Z");

    expect(codeEntry(report, "ai_transient", "AI_TIMEOUT")?.count).toBe(1);
    expect(codeEntry(report, "ai_transient", "DEPENDENCY_ERROR")?.count).toBe(1);
    expect(codeEntry(report, "server_fault", "DEPENDENCY_ERROR")?.count).toBe(1);
    expect(codeEntry(report, "server_fault", "DATABASE_ERROR")?.count).toBe(1);
    expect(codeEntry(report, "server_fault", "INTERNAL_ERROR")?.count).toBe(1);
    expect(codeEntry(report, "server_fault", "HTTP_5XX")?.count).toBe(1);

    expect(report.excluded.find((entry) => entry.code === "VALIDATION_ERROR")?.count).toBe(1);
    expect(report.excluded.find((entry) => entry.code === "AI_QUOTA")?.count).toBe(1);
    expect(report.excluded.find((entry) => entry.code === "HTTP_4XX")?.count).toBe(1);

    expect(
      report.monitored.find((entry) => entry.code === "FINANCIAL_STATE_INCOMPLETE")?.count,
    ).toBe(1);
    expect(report.monitored.find((entry) => entry.code === "AI_TIMEOUT_METRIC")?.count).toBe(1);
    expect(report.financialSignals).toBe(2);
    expect(report.aiMetricTimeouts).toBe(1);
    expect(report.parsed.skipped).toBe(0);
  });

  it("não deixa eventos fora da janela consumirem budget", () => {
    const args = parseArgs(["--window=7d", "--min-requests=10"]);
    const report = buildReport(fixture("basic-7d.jsonl"), args, "fixture");
    expect(codeEntry(report, "server_fault", "DATABASE_ERROR")?.count).toBe(1);
    expect(codeEntry(report, "server_fault", "INTERNAL_ERROR")?.count).toBe(1);
  });

  it("calcula consumo das classes e mantém IA em DRAFT antes do baseline", () => {
    const args = parseArgs(["--window=7d", "--min-requests=10"]);
    const report = buildReport(fixture("basic-7d.jsonl"), args, "fixture");
    const financial = report.classes.find((entry) => entry.id === "financial_critical")!;
    const ai = report.classes.find((entry) => entry.id === "ai_transient")!;
    const server = report.classes.find((entry) => entry.id === "server_fault")!;

    expect(financial.verdict).toBe("OK");
    expect(financial.consumption).toBe(0);
    expect(ai.consumption).toBe(2);
    expect(ai.basis).toBe(3);
    expect(ai.verdict).toBe("DRAFT");
    expect(ai.toleranceDisplay).toContain("não ratificada");
    expect(server.consumption).toBe(4);
    expect(server.verdict).toBe("EXHAUSTED");

    expect(report.verdict).toBe("FAIL");
    expect(report.exitCode).toBe(1);
  });
});

describe("buildReport — fail-closed", () => {
  it("não emite veredito verde abaixo do N mínimo", () => {
    const report = buildReport(
      fixture("insufficient.jsonl"),
      parseArgs(["--window=7d"]),
      "fixture",
    );
    expect(report.requests.total).toBe(2);
    expect(report.verdict).toBe("INSUFFICIENT");
    expect(report.exitCode).toBe(2);
    const markdown = renderReport(report);
    expect(markdown).toContain("**Veredito: INSUFFICIENT**");
    expect(markdown).toContain("fail-closed");
  });

  it("mantém classe financeira UNKNOWN sem linhas de métrica", () => {
    const raw = [
      '{"timestamp":"2026-09-13T12:00:00.000Z","event":"request.completed","status":200,"correlationId":"c-1"}',
      '{"timestamp":"2026-09-13T11:59:00.000Z","event":"request.completed","status":200,"correlationId":"c-2"}',
    ].join("\n");
    const report = buildReport(raw, parseArgs(["--window=7d", "--min-requests=2"]), "inline");
    const financial = report.classes.find((entry) => entry.id === "financial_critical")!;
    expect(financial.verdict).toBe("UNKNOWN");
    expect(report.verdict).toBe("INDETERMINATE");
    expect(report.exitCode).toBe(2);
  });

  it("excede o budget financeiro e retorna FAIL mesmo com N baixo", () => {
    const report = buildReport(
      fixture("financial-invalid.jsonl"),
      parseArgs(["--window=7d", "--min-requests=1000"]),
      "fixture",
    );
    const financial = report.classes.find((entry) => entry.id === "financial_critical")!;
    expect(financial.verdict).toBe("EXHAUSTED");
    expect(report.verdict).toBe("FAIL");
    expect(report.exitCode).toBe(1);
  });
});

describe("buildReport — tolerância de IA após baseline", () => {
  it("usa 1% sobre as requisições de chat e fica OK quando dentro do budget", () => {
    const base = Date.parse("2026-09-13T12:00:00.000Z");
    const lines: string[] = [];
    for (let index = 0; index < 100; index++) {
      const correlationId = `chat-${index}`;
      lines.push(
        JSON.stringify({
          timestamp: new Date(base - index * 1_000).toISOString(),
          level: "info",
          event: "ai.chat_completed",
          correlationId,
        }),
        JSON.stringify({
          timestamp: new Date(base - index * 1_000 - 500).toISOString(),
          level: "info",
          event: "request.completed",
          correlationId,
          status: 200,
        }),
        JSON.stringify({
          timestamp: new Date(base - index * 1_000 - 100).toISOString(),
          level: "info",
          event: "app.financial.states",
          state: "reachable",
        }),
      );
    }
    lines.push(
      JSON.stringify({
        timestamp: new Date(base - 200_000).toISOString(),
        level: "error",
        event: "request.failed",
        code: "AI_TIMEOUT",
        correlationId: "chat-timeout",
      }),
    );
    const args = parseArgs([
      "--window=7d",
      "--min-requests=100",
      "--baseline=docs/evidence/m06-baseline.md",
    ]);
    const report = buildReport(lines.join("\n"), args, "inline");
    const ai = report.classes.find((entry) => entry.id === "ai_transient")!;
    expect(ai.basis).toBe(101);
    expect(ai.consumption).toBe(1);
    expect(ai.toleranceDisplay).toContain(`${AI_TOLERANCE_RATE * 100}%`);
    expect(ai.verdict).toBe("OK");
    expect(report.verdict).toBe("OK");
    expect(report.exitCode).toBe(0);
  });
});

describe("renderReport", () => {
  it("marca DRAFT/NÃO-RATIFICADO e lista classes, códigos e exclusões", () => {
    const report = buildReport(
      fixture("basic-7d.jsonl"),
      parseArgs(["--window=7d", "--min-requests=10"]),
      "fixture",
    );
    const markdown = renderReport(report);
    expect(markdown).toContain("DRAFT / NÃO-RATIFICADO");
    expect(markdown).toContain("app.financial.states{state=invalid}");
    expect(markdown).toContain("## Excluídos do budget");
    expect(markdown).toContain("VALIDATION_ERROR");
    expect(markdown).toContain("docs/specs/M-06/error-budget.md");
    expect(markdown).toContain("ADR-022");
  });
});
