import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setHttpResponseStatus, withHttpRequestSpan } from "@/instrumentation/http-request-span";
import type { RequestContext } from "@/lib/request-context";
import { withBffSpan } from "@/middleware/request-context";
import type {
  DashboardInputs,
  DashboardRepository,
} from "@/server/repositories/dashboard.repository";
import type { SalesSummary } from "@/server/repositories/sales.repository";
import { DefaultDashboardService } from "@/server/services/dashboard.service";
import type { SalesService } from "@/server/services/sales.service";
import { contextWithRole } from "./helpers/request-context";

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

const requestAttributes = {
  "http.request.method": "POST",
  "url.path": "/_serverFn/dashboard",
  "app.correlation_id": "60000000-0000-4000-8000-000000000006",
};

describe("setHttpResponseStatus", () => {
  it("grava http.response.status_code e marca 2xx/4xx como OK", () => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn() };

    setHttpResponseStatus(span, 200);
    setHttpResponseStatus(span, 404);

    expect(span.setAttribute).toHaveBeenNthCalledWith(1, "http.response.status_code", 200);
    expect(span.setAttribute).toHaveBeenNthCalledWith(2, "http.response.status_code", 404);
    expect(span.setStatus).toHaveBeenCalledTimes(2);
    expect(span.setStatus).toHaveBeenNthCalledWith(1, { code: SpanStatusCode.OK });
    expect(span.setStatus).toHaveBeenNthCalledWith(2, { code: SpanStatusCode.OK });
  });

  it("marca 5xx como ERROR", () => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn() };

    setHttpResponseStatus(span, 503);

    expect(span.setAttribute).toHaveBeenCalledWith("http.response.status_code", 503);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });
});

describe("withHttpRequestSpan (span em memória, sem OTLP)", () => {
  it("abre http.request com url.path/correlation_id e fecha 200 em OK", async () => {
    const value = await withHttpRequestSpan(requestAttributes, async (span) => {
      setHttpResponseStatus(span, 200);
      return "ok";
    });

    expect(value).toBe("ok");
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("http.request");
    expect(span.attributes).toMatchObject({
      ...requestAttributes,
      "http.response.status_code": 200,
    });
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("mantém 4xx em OK (ERROR apenas ≥500)", async () => {
    await withHttpRequestSpan(requestAttributes, async (span) => {
      setHttpResponseStatus(span, 404);
      return undefined;
    });

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["http.response.status_code"]).toBe(404);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("marca 5xx como ERROR no span encerrado", async () => {
    await withHttpRequestSpan(requestAttributes, async (span) => {
      setHttpResponseStatus(span, 503);
      return undefined;
    });

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["http.response.status_code"]).toBe(503);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("encerra o span e grava a exceção quando a operação lança Error", async () => {
    await expect(
      withHttpRequestSpan(requestAttributes, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });
});

describe("bff.request (span em memória, sem OTLP)", () => {
  it("abre e fecha bff.request com nome do middleware e correlationId", async () => {
    const value = await withBffSpan("requireDatabaseIdentity", "corr-42", async () => "identity");

    expect(value).toBe("identity");
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("bff.request");
    expect(span.attributes).toMatchObject({
      "app.bff.middleware": "requireDatabaseIdentity",
      "app.correlation_id": "corr-42",
    });
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("propaga o erro do middleware e fecha o span em ERROR", async () => {
    const failure = new Error("db down");

    await expect(
      withBffSpan("requireDatabaseAuth", "corr-43", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["app.bff.middleware"]).toBe("requireDatabaseAuth");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

const TENANT_ID = "50000000-0000-4000-8000-000000000005";

class FakeDashboardRepository implements DashboardRepository {
  async loadInputs(): Promise<DashboardInputs> {
    return {
      productRows: [],
      expenseRows: [],
      ingredientRows: [],
      packagingRows: [],
      feeRows: [],
      marketRows: [],
    };
  }
}

class FakeSalesService implements SalesService {
  constructor(private readonly summary: SalesSummary = { revenue: "0.0000", count: 0 }) {}

  async create(): Promise<never> {
    throw new Error("NOT_IMPLEMENTED");
  }

  async revenue(): Promise<string> {
    return "0.0000";
  }

  async summaryForPeriod(): Promise<SalesSummary> {
    return this.summary;
  }

  async list(): Promise<never> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

class FailingSalesService extends FakeSalesService {
  override async summaryForPeriod(): Promise<SalesSummary> {
    throw new Error("sales down");
  }
}

describe("service.dashboard.sales_summary (span em memória, sem OTLP)", () => {
  it("cobre a chamada de sales com atributos sem PII e status OK", async () => {
    const service = new DefaultDashboardService(
      new FakeDashboardRepository(),
      new FakeSalesService({ revenue: "150.0000", count: 3 }),
    );
    const context: RequestContext = contextWithRole("owner");

    await service.getSummary(context, "quarter");

    const span = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "service.dashboard.sales_summary");
    expect(span).toBeDefined();
    expect(span?.attributes).toMatchObject({
      "app.tenant_id": TENANT_ID,
      "app.correlation_id": context.correlationId,
      "app.dashboard.period": "quarter",
      "app.sales.count": 3,
    });
    expect(span?.attributes).not.toHaveProperty("app.sales.revenue");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("marca ERROR e registra exceção quando sales falha", async () => {
    const service = new DefaultDashboardService(
      new FakeDashboardRepository(),
      new FailingSalesService(),
    );

    await expect(service.getSummary(contextWithRole("owner"))).rejects.toThrow("sales down");

    const span = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "service.dashboard.sales_summary");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((event) => event.name === "exception")).toBe(true);
  });
});
