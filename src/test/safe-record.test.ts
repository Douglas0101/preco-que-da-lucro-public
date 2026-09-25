import "./helpers/otel-metrics";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attributes } from "@opentelemetry/api";
import type { Database } from "@/db/client.server";
import {
  instrumentPoolRoundTrips,
  setDatabaseForTests,
  withTenantTransaction,
} from "@/db/client.server";
import { recordSafely } from "@/instrumentation/safe-record";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { startInstance } from "@/start";
import { GATEWAY_TOOLS } from "@/lib/ai/tool-registry";
import { runRegisteredTool } from "@/lib/ai/tool-runner";
import { callModelForTests } from "@/lib/chat.functions";
import type { DashboardRepository } from "@/server/repositories/dashboard.repository";
import { DefaultDashboardService } from "@/server/services/dashboard.service";
import type { SalesService } from "@/server/services/sales.service";
import {
  captureStructuredLogs,
  contentResponse,
  installFakeDatabase,
  restoreFakeDatabase,
  runFakeChat,
} from "./helpers/chat-execution-fakes";
import { contextWithRole } from "./helpers/request-context";
import { FakeTransaction, fakeContext } from "./helpers/tool-runner-fakes";

/**
 * F2C-1: nenhum dos 11 sítios de `record` fora de `client.server.ts` pode
 * quebrar o caminho da request quando o `record` lança. O stub abaixo registra
 * os argumentos recebidos ANTES de lançar: a mesma execução prova o
 * comportamento defensivo e a byte-identidade dos argumentos emitidos.
 */
type SpyableMetric = { record: (value: number, attributes?: Attributes) => void };

function throwAfterRecording(metric: SpyableMetric, calls: unknown[][]): void {
  vi.spyOn(metric, "record").mockImplementation((...args: unknown[]) => {
    calls.push(args);
    throw new Error("metric boom");
  });
}

/** Captura os argumentos de um `record` sadio, sem lançar. */
function recordCalls(metric: SpyableMetric): unknown[][] {
  const calls: unknown[][] = [];
  vi.spyOn(metric, "record").mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  return calls;
}

/** `logJson("error", ...)` escreve em `console.error`, não em `console.info`. */
function captureErrorLogs(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "error").mockImplementation((record: unknown) => {
    events.push(JSON.parse(String(record)) as Record<string, unknown>);
  });
  return events;
}

/**
 * Uma promessa que não assenta trava a suíte; o deadline converte um hang em
 * falha determinística com o rótulo do sítio.
 */
async function withinDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`hang: ${label}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/** Serviço de dashboard com repository/sales mínimos, sem PostgreSQL. */
function buildDashboardService(): DefaultDashboardService {
  const repository = {
    loadInputs: async () => ({
      productRows: [],
      expenseRows: [],
      ingredientRows: [],
      packagingRows: [],
      feeRows: [],
      marketRows: [],
    }),
  } as unknown as DashboardRepository;
  const sales = {
    summaryForPeriod: async () => ({ revenue: "0.0000", count: 0 }),
  } as unknown as SalesService;
  return new DefaultDashboardService(repository, sales);
}

afterEach(() => {
  restoreFakeDatabase();
  setDatabaseForTests(undefined);
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
});

describe("recordSafely: o idioma único de registro de métrica", () => {
  it("encaminha os argumentos byte-idênticos, com e sem atributos", () => {
    const metric: SpyableMetric = { record: () => undefined };
    const calls = recordCalls(metric);

    recordSafely(metric, 7);
    recordSafely(metric, 8, { status: 200 });

    expect(calls).toStrictEqual([[7], [8, { status: 200 }]]);
  });

  it("engole um record que lança e não devolve nada", () => {
    const metric: SpyableMetric = {
      record: () => {
        throw new Error("metric boom");
      },
    };

    expect(() => recordSafely(metric, 1, { status: 500 })).not.toThrow();
    expect(recordSafely(metric, 1)).toBeUndefined();
  });

  it("nenhum módulo de produção chama applicationMetrics.*.record() direto", () => {
    const offenders: string[] = [];
    const directRecord = /applicationMetrics\.[A-Za-z0-9_]+\.record\(/;

    for (const file of productionSources(join(process.cwd(), "src"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (directRecord.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

/** Fontes de produção: sem testes e sem o próprio helper. */
function productionSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...productionSources(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    if (path.endsWith(join("instrumentation", "safe-record.ts"))) continue;
    found.push(path);
  }
  return found;
}

interface PolicyMiddlewareContext {
  handlerType: "serverFn" | "ssr";
  request: Request;
  next: (options: { context: { correlationId: string } }) => Promise<{ response: Response }>;
}

type PolicyMiddlewareOutcome = { response: Response } | Response;
type PolicyMiddleware = (ctx: PolicyMiddlewareContext) => Promise<PolicyMiddlewareOutcome>;

/** O caminho de sucesso devolve `{ response }`; `handleUnexpectedError` devolve
 * o `Response` diretamente — o middleware repassa o que o handler devolveu. */
function responseOf(outcome: PolicyMiddlewareOutcome): Response {
  return outcome instanceof Response ? outcome : outcome.response;
}

/**
 * O `requestPolicyMiddleware` é privado em `start.ts`; o seam é a própria
 * `startInstance`, cujo `requestMiddleware[0]` é ele (ordem declarada no
 * arquivo). Se a ordem mudar, o teste falha em vez de medir outro middleware.
 */
async function requestPolicy(): Promise<PolicyMiddleware> {
  const options = (await startInstance.getOptions()) as unknown as {
    requestMiddleware?: Array<{ options?: { server?: unknown } }>;
  };
  const server = options.requestMiddleware?.[0]?.options?.server;
  if (typeof server !== "function") {
    throw new Error("requestPolicyMiddleware não encontrado em startInstance");
  }
  return server as PolicyMiddleware;
}

describe("start.ts: record que lança não derruba a resposta nem mascara o erro", () => {
  const request = () => new Request("https://app.test/produtos");

  it("caminho feliz: a resposta 200 é devolvida com record lançando", async () => {
    const policy = await requestPolicy();
    const logs = captureStructuredLogs();
    const errors = captureErrorLogs();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.requestDuration, calls);

    const outcome = await withinDeadline(
      policy({
        handlerType: "serverFn",
        request: request(),
        next: async () => ({ response: new Response("ok", { status: 200 }) }),
      }),
      "middleware feliz",
    );

    expect(responseOf(outcome).status).toBe(200);
    await expect(responseOf(outcome).text()).resolves.toBe("ok");
    expect(responseOf(outcome).headers.get("x-correlation-id")).toBeTruthy();
    expect(logs.map((entry) => entry.event)).toContain("request.completed");
    // O caminho feliz não pode virar um 500 registrado por causa da métrica.
    expect(errors.map((entry) => entry.event)).not.toContain("request.failed");
    expect(calls).toStrictEqual([[expect.any(Number), { method: "GET", status: 200 }]]);
  });

  it("handleResponseError: o Response original continua sendo o objeto lançado", async () => {
    const policy = await requestPolicy();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.requestDuration, calls);
    const original = new Response("indisponível", { status: 503 });

    await expect(
      withinDeadline(
        policy({
          handlerType: "serverFn",
          request: request(),
          next: async () => {
            throw original;
          },
        }),
        "middleware response error",
      ),
    ).rejects.toBe(original);
    expect(calls).toStrictEqual([[expect.any(Number), { method: "GET", status: 503 }]]);
  });

  it("handleUnexpectedError: o erro real do handler chega ao log e vira 500", async () => {
    const policy = await requestPolicy();
    const errors = captureErrorLogs();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.requestDuration, calls);

    const outcome = await withinDeadline(
      policy({
        handlerType: "serverFn",
        request: request(),
        next: async () => {
          throw new Error("db exploded");
        },
      }),
      "middleware unexpected error",
    );

    expect(responseOf(outcome).status).toBe(500);
    const failed = errors.find((entry) => entry.event === "request.failed");
    expect(failed).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(failed)).toContain("db exploded");
    expect(JSON.stringify(failed)).not.toContain("metric boom");
    expect(calls).toStrictEqual([[expect.any(Number), { method: "GET", status: 500 }]]);
  });
});

describe("chat.functions.ts: aiDuration dentro do finally de runModelAttempt", () => {
  const MESSAGES = [{ role: "user" as const, content: "Olá" }];

  it("um record que lança não rejeita a resposta do gateway nem pula o log da tentativa", async () => {
    process.env.AI_GATEWAY_API_KEY = "chave-de-teste";
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ choices: [{ message: { content: "Tudo bem" } }] })),
    );
    const logs = captureStructuredLogs();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.aiDuration, calls);

    await expect(
      withinDeadline(
        callModelForTests(MESSAGES, GATEWAY_TOOLS, new AbortController().signal),
        "callModel",
      ),
    ).resolves.toMatchObject({ choices: [{ message: { content: "Tudo bem" } }] });

    expect(logs.find((entry) => entry.event === "ai.model_attempt")).toMatchObject({
      outcome: "success",
    });
    expect(calls).toStrictEqual([[expect.any(Number), { model: expect.any(String), attempt: 1 }]]);
  });
});

describe("chat-execution.server.ts: as três fases do §29 não derrubam o chat", () => {
  it("aiTimeToAcknowledge.record que lança não rejeita o chat", async () => {
    installFakeDatabase();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.aiTimeToAcknowledge, calls);

    const result = await withinDeadline(
      runFakeChat(async () => contentResponse()),
      "chat acknowledge",
    );

    expect(result).toMatchObject({ kind: "complete", content: "Pronto!" });
    expect(calls).toStrictEqual([[expect.any(Number)]]);
  });

  it("aiTimeToFirstContent.record que lança não rejeita o chat", async () => {
    installFakeDatabase();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.aiTimeToFirstContent, calls);

    const result = await withinDeadline(
      runFakeChat(async () => contentResponse()),
      "chat first content",
    );

    expect(result).toMatchObject({ kind: "complete", content: "Pronto!" });
    expect(calls).toStrictEqual([[expect.any(Number)]]);
  });

  it("aiTimeToFinal.record que lança não rejeita o chat", async () => {
    installFakeDatabase();
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.aiTimeToFinal, calls);

    const result = await withinDeadline(
      runFakeChat(async () => contentResponse()),
      "chat final",
    );

    expect(result).toMatchObject({ kind: "complete", content: "Pronto!" });
    expect(calls).toStrictEqual([[expect.any(Number)]]);
  });
});

describe("dashboard.service.ts: salesSummaryDuration", () => {
  it("um record que lança não derruba o resumo", async () => {
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.salesSummaryDuration, calls);

    const summary = await withinDeadline(
      buildDashboardService().getSummary(contextWithRole("owner"), "month"),
      "dashboard summary",
    );

    expect(summary).toMatchObject({ productCount: 0, sales: { revenue: "0.0000", count: 0 } });
    expect(calls).toStrictEqual([[expect.any(Number), { period: "month" }]]);
  });
});

describe("tool-runner.ts: toolDuration nos três caminhos", () => {
  it("rejeição por Zod: o resultado VALIDATION_ERROR sobrevive ao record", async () => {
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.toolDuration, calls);

    const result = await withinDeadline(
      runRegisteredTool({
        context: fakeContext(new FakeTransaction()),
        name: "create_product",
        rawArguments: "{não-é-json",
        idempotencyKey: "conversation:call-safe-record-rejeitado",
      }),
      "tool rejeitada",
    );

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR", replayed: false });
    expect(calls).toStrictEqual([
      [expect.any(Number), { tool: "create_product", status: "rejected" }],
    ]);
  });

  it("sucesso: a execução persiste e o resultado ok sobrevive ao record", async () => {
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.toolDuration, calls);

    const result = await withinDeadline(
      runRegisteredTool({
        context: fakeContext(new FakeTransaction()),
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Bolo" }),
        idempotencyKey: "conversation:call-safe-record-sucesso",
      }),
      "tool com sucesso",
    );

    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(calls).toStrictEqual([
      [expect.any(Number), { tool: "create_product", status: "succeeded" }],
    ]);
  });

  it("falha: AI_TIMEOUT não é substituído pelo erro da métrica", async () => {
    const calls: unknown[][] = [];
    throwAfterRecording(applicationMetrics.toolDuration, calls);

    const result = await withinDeadline(
      runRegisteredTool({
        context: { ...fakeContext(new FakeTransaction()), signal: abortedSignal() },
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Bolo" }),
        idempotencyKey: "conversation:call-safe-record-cancelado",
      }),
      "tool cancelada",
    );

    expect(result).toEqual({ ok: false, code: "AI_TIMEOUT", replayed: false });
    expect(calls).toStrictEqual([
      [expect.any(Number), { tool: "create_product", status: "cancelled" }],
    ]);
  });
});

describe("args byte-idênticos no caminho saudável (captura sem lançar)", () => {
  it("start.ts: os três caminhos de requestDuration", async () => {
    const calls = recordCalls(applicationMetrics.requestDuration);
    const policy = await requestPolicy();
    const csrfError = new Response("indisponível", { status: 503 });

    await withinDeadline(
      policy({
        handlerType: "serverFn",
        request: new Request("https://app.test/produtos"),
        next: async () => ({ response: new Response("ok", { status: 200 }) }),
      }),
      "middleware feliz",
    );
    await expect(
      policy({
        handlerType: "serverFn",
        request: new Request("https://app.test/produtos"),
        next: async () => {
          throw csrfError;
        },
      }),
    ).rejects.toBe(csrfError);
    await withinDeadline(
      policy({
        handlerType: "serverFn",
        request: new Request("https://app.test/produtos"),
        next: async () => {
          throw new Error("db exploded");
        },
      }),
      "middleware unexpected error",
    );

    expect(calls).toStrictEqual([
      [expect.any(Number), { method: "GET", status: 200 }],
      [expect.any(Number), { method: "GET", status: 503 }],
      [expect.any(Number), { method: "GET", status: 500 }],
    ]);
  });

  it("chat.functions.ts: aiDuration", async () => {
    process.env.AI_GATEWAY_API_KEY = "chave-de-teste";
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ choices: [{ message: { content: "Tudo bem" } }] })),
    );
    const calls = recordCalls(applicationMetrics.aiDuration);

    await withinDeadline(
      callModelForTests(
        [{ role: "user" as const, content: "Olá" }],
        GATEWAY_TOOLS,
        new AbortController().signal,
      ),
      "callModel",
    );

    expect(calls).toStrictEqual([[expect.any(Number), { model: expect.any(String), attempt: 1 }]]);
  });

  it("chat-execution.server.ts: as três fases do §29", async () => {
    installFakeDatabase();
    const acknowledge = recordCalls(applicationMetrics.aiTimeToAcknowledge);
    const firstContent = recordCalls(applicationMetrics.aiTimeToFirstContent);
    const final = recordCalls(applicationMetrics.aiTimeToFinal);

    await withinDeadline(
      runFakeChat(async () => contentResponse()),
      "chat §29",
    );

    expect(acknowledge).toStrictEqual([[expect.any(Number)]]);
    expect(firstContent).toStrictEqual([[expect.any(Number)]]);
    expect(final).toStrictEqual([[expect.any(Number)]]);
  });

  it("dashboard.service.ts: salesSummaryDuration", async () => {
    const calls = recordCalls(applicationMetrics.salesSummaryDuration);

    await withinDeadline(
      buildDashboardService().getSummary(contextWithRole("owner"), "quarter"),
      "dashboard summary",
    );

    expect(calls).toStrictEqual([[expect.any(Number), { period: "quarter" }]]);
  });

  it("tool-runner.ts: toolDuration nos três caminhos", async () => {
    const calls = recordCalls(applicationMetrics.toolDuration);

    await withinDeadline(
      runRegisteredTool({
        context: fakeContext(new FakeTransaction()),
        name: "create_product",
        rawArguments: "{não-é-json",
        idempotencyKey: "conversation:call-byte-id-rejeitado",
      }),
      "tool rejeitada",
    );
    await withinDeadline(
      runRegisteredTool({
        context: fakeContext(new FakeTransaction()),
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Bolo" }),
        idempotencyKey: "conversation:call-byte-id-sucesso",
      }),
      "tool com sucesso",
    );
    await withinDeadline(
      runRegisteredTool({
        context: { ...fakeContext(new FakeTransaction()), signal: abortedSignal() },
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Bolo" }),
        idempotencyKey: "conversation:call-byte-id-cancelado",
      }),
      "tool cancelada",
    );

    expect(calls).toStrictEqual([
      [expect.any(Number), { tool: "create_product", status: "rejected" }],
      [expect.any(Number), { tool: "create_product", status: "succeeded" }],
      [expect.any(Number), { tool: "create_product", status: "cancelled" }],
    ]);
  });
});

describe("client.server.ts: delegação emite os mesmos argumentos", () => {
  const IDENTITY = { userId: "user-1", tenantId: "tenant-1", roles: ["owner"] };

  it("dbPoolWaitTime, dbQueryDuration e dbDuration mantêm aridade e atributos", async () => {
    const wait = recordCalls(applicationMetrics.dbPoolWaitTime);
    const query = recordCalls(applicationMetrics.dbQueryDuration);
    const duration = recordCalls(applicationMetrics.dbDuration);

    const client = { query: async (_text: string) => ({ rows: [] }) };
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 10 },
      connect: async () => client,
    };
    const handle = instrumentPoolRoundTrips(pool, "node-postgres");
    const instrumented = await (pool.connect as () => Promise<typeof client>)();
    await instrumented.query("select 1");

    setDatabaseForTests({
      transaction: async <T>(operation: (transaction: unknown) => Promise<T>): Promise<T> =>
        operation({ execute: async () => ({ rows: [] }) }),
    } as unknown as Database);
    await withTenantTransaction(IDENTITY, async () => "ok");

    handle?.unregister();

    expect(wait).toStrictEqual([[expect.any(Number), { driver: "node-postgres" }]]);
    expect(query).toStrictEqual([
      [expect.any(Number), { "db.operation.name": "SELECT", "db.system.name": "postgresql" }],
    ]);
    expect(duration).toStrictEqual([[expect.any(Number)]]);
  });
});
