import { type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  marketPrices,
  productIngredients,
  productPackaging,
  products,
  salesFees,
  type Product,
} from "@/db/schema";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { getProduct, listProductsWithMetrics } from "@/lib/products.functions";
import type { RequestContext } from "@/lib/request-context";
import type {
  DashboardInputs,
  DashboardRepository,
} from "@/server/repositories/dashboard.repository";
import type { SalesSummary } from "@/server/repositories/sales.repository";
import { DefaultDashboardService } from "@/server/services/dashboard.service";
import { getDiagnostic } from "@/server/services/diagnostic.service";
import { FINANCE_ENGINE_VERSION } from "@/server/services/financial.service";
import { calculateProductReadModel } from "@/server/services/product-read-model.service";
import type { SalesService } from "@/server/services/sales.service";
import { contextWithRole } from "./helpers/request-context";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    };
    return builder;
  },
}));

/** Despesas fixas devolvidas por `expenseService` no caminho do diagnóstico.
 * Um valor não numérico torna `breakEvenUnits` inválido mesmo com o cálculo do
 * produto `ok` — é assim que o status da view diverge do status do read model. */
const expenseMocks = vi.hoisted(() => ({
  rows: [] as Array<{ type: string; amount: string }>,
}));

vi.mock("@/server/services/expense.service", () => ({
  expenseService: { list: async () => expenseMocks.rows },
}));

vi.mock("@/server/services/calculation-snapshot.service", () => ({
  calculationSnapshotService: { append: async () => ({}) },
  deriveSnapshotIdempotencyKey: () => "test-idempotency-key",
}));

vi.mock("@/server/services/pricing.service", async () => {
  const { calcIncomplete, calcOk } = await import("@/lib/finance");
  return {
    pricingService: {
      calculatePriceFormationFor: () => ({
        minimumSustainablePrice: calcOk(12),
        targetMarginPrice: calcOk(18),
        marketReference: calcIncomplete([]),
      }),
      appendPricingSnapshot: async () => undefined,
    },
  };
});

const TENANT_ID = "aaaaaaa1-0000-4000-8000-000000000001";
const CORRELATION_ID = "aaaaaaa2-0000-4000-8000-000000000002";

type ProductRow = typeof products.$inferSelect;
type IngredientSelect = typeof productIngredients.$inferSelect;
type PackagingSelect = typeof productPackaging.$inferSelect;
type FeeSelect = typeof salesFees.$inferSelect;
type MarketSelect = typeof marketPrices.$inferSelect;

interface Dataset {
  products: ProductRow[];
  ingredients: IngredientSelect[];
  packaging: PackagingSelect[];
  fees: FeeSelect[];
  market: MarketSelect[];
}

const okProduct: ProductRow = {
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: TENANT_ID,
  userId: "user-1",
  name: "Bolo de Cacau",
  status: "active",
  currentPrice: "25.0000",
  yieldQty: "1.000000",
  yieldUnit: "unidades",
  taxRegime: "simples nacional",
  taxRate: "0.100000",
  isDemo: false,
  notes: null,
  version: 0,
  archivedAt: null,
  createdAt: new Date("2026-01-03T10:00:00.000Z"),
  updatedAt: new Date("2026-01-03T10:00:00.000Z"),
};

const invalidProduct: ProductRow = {
  ...okProduct,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Pão Artesanal",
  status: "draft",
  currentPrice: "-1.0000",
  yieldQty: "1.000000",
  createdAt: new Date("2026-01-02T10:00:00.000Z"),
  updatedAt: new Date("2026-01-02T10:00:00.000Z"),
};

const ingredient: IngredientSelect = {
  id: "00000000-0000-4000-8000-000000000011",
  productId: okProduct.id,
  tenantId: TENANT_ID,
  userId: "user-1",
  name: "Farinha",
  usedQty: "1.000000",
  usedUnit: "kg",
  packagePrice: "10.0000",
  packageQty: "1.000000",
  packageUnit: "kg",
  conversionFactor: "1.00000000",
  priceUpdatedAt: new Date("2026-01-02T12:00:00.000Z"),
  createdAt: new Date("2026-01-03T10:05:00.000Z"),
  updatedAt: new Date("2026-01-03T10:05:00.000Z"),
};

const dataset: Dataset = {
  products: [okProduct, invalidProduct],
  ingredients: [ingredient],
  packaging: [],
  fees: [],
  market: [],
};

function createFakeTransaction(data: Dataset) {
  const dialect = new PgDialect();
  const queryBuilder = new QueryBuilder();
  const unionRow = (branch: number, kind: string, row: object, index: number) => ({
    branch,
    ord: index + 1,
    kind,
    ...row,
  });
  const rowsForTable = (renderedSql: string): object[] => {
    if (renderedSql.includes('from "products"')) return data.products;
    if (renderedSql.includes('from "product_ingredients"')) return data.ingredients;
    if (renderedSql.includes('from "product_packaging"')) return data.packaging;
    if (renderedSql.includes('from "sales_fees"')) return data.fees;
    if (renderedSql.includes('from "market_prices"')) return data.market;
    return [];
  };
  const project = (fields: Record<string, unknown> | undefined, rows: object[]) =>
    fields
      ? rows.map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, (row as never)[key]])),
        )
      : rows;

  const transaction = {
    select(fields?: Record<string, unknown>) {
      const real = fields ? queryBuilder.select(fields as never) : queryBuilder.select();
      const proxify = (target: object): unknown =>
        new Proxy(target, {
          get(t, property) {
            if (property === "then") {
              return (onfulfilled?: (value: unknown) => unknown) => {
                const rendered = (t as { toSQL(): { sql: string } }).toSQL().sql;
                return Promise.resolve(project(fields, rowsForTable(rendered))).then(onfulfilled);
              };
            }
            const value = Reflect.get(t, property, t);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const result = (value as (...a: unknown[]) => unknown).apply(t, args);
              if (result && typeof result === "object") return proxify(result);
              return result;
            };
          },
        });
      return proxify(real as object);
    },
    async execute(fragment: SQL) {
      const rendered = dialect.sqlToQuery(fragment).sql;
      const rows: Record<string, unknown>[] = [];
      if (rendered.includes('from "product_ingredients"')) {
        rows.push(...data.ingredients.map((row, index) => unionRow(1, "ingredient", row, index)));
      }
      if (rendered.includes('from "product_packaging"')) {
        rows.push(...data.packaging.map((row, index) => unionRow(2, "packaging", row, index)));
      }
      if (rendered.includes('from "sales_fees"')) {
        rows.push(...data.fees.map((row, index) => unionRow(3, "fee", row, index)));
      }
      if (rendered.includes('from "market_prices"')) {
        rows.push(...data.market.map((row, index) => unionRow(4, "market", row, index)));
      }
      return { rows };
    },
  };
  return transaction as unknown as RequestContext["transaction"];
}

function contextWithTransaction(transaction: RequestContext["transaction"]): RequestContext {
  return {
    userId: "user-1",
    tenantId: TENANT_ID,
    roles: ["owner"],
    correlationId: CORRELATION_ID,
    signal: new AbortController().signal,
    transaction,
  };
}

async function invokeHandler(
  handler: unknown,
  input: { data?: unknown; context: { requestContext: RequestContext } },
): Promise<unknown> {
  return (
    handler as unknown as (args: {
      data?: unknown;
      context: { requestContext: RequestContext };
    }) => Promise<unknown>
  )(input);
}

/** O meter no-op compartilha o mesmo counter em testes, então cada asserção
 * isola o instrumento pela chave de atributo emitida. */
function callsWith(add: { mock: { calls: unknown[][] } }, key: string): unknown[][] {
  return add.mock.calls.filter(
    ([, attributes]) => typeof attributes === "object" && attributes !== null && key in attributes,
  );
}

describe("app.financial.states no choke point do read model", () => {
  const okInput = {
    persistedStatus: "active" as const,
    currentPrice: "25",
    yieldQty: "1",
    taxRate: "0.1",
    ingredients: [
      {
        used_qty: 1,
        used_unit: "kg",
        package_price: 10,
        package_qty: 1,
        package_unit: "kg",
      },
    ],
    packaging: [],
    fees: [],
  };

  it("emite estado ok com a versão do motor", () => {
    const add = vi.spyOn(applicationMetrics.financialStates, "add");

    const calculation = calculateProductReadModel(okInput);

    expect(calculation.metrics.status).toBe("ok");
    expect(callsWith(add, "state")).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("emite estado incomplete com a versão do motor", () => {
    const add = vi.spyOn(applicationMetrics.financialStates, "add");

    const calculation = calculateProductReadModel({ ...okInput, currentPrice: null });

    expect(calculation.metrics.status).toBe("incomplete");
    expect(callsWith(add, "state")).toEqual([
      [1, { state: "incomplete", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("emite estado invalid com a versão do motor", () => {
    const add = vi.spyOn(applicationMetrics.financialStates, "add");

    const calculation = calculateProductReadModel({ ...okInput, currentPrice: "-1" });

    expect(calculation.metrics.status).toBe("invalid");
    expect(callsWith(add, "state")).toEqual([
      [1, { state: "invalid", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("não duplica a emissão na lista: um evento por produto", async () => {
    const add = vi.spyOn(applicationMetrics.financialStates, "add");

    const response = await invokeHandler(listProductsWithMetrics, {
      context: { requestContext: contextWithTransaction(createFakeTransaction(dataset)) },
    });

    expect(response).toHaveLength(2);
    expect(callsWith(add, "state")).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
      [1, { state: "invalid", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("emite o detalhe uma única vez por produto", async () => {
    const add = vi.spyOn(applicationMetrics.financialStates, "add");
    const detailDataset: Dataset = { ...dataset, products: [okProduct] };

    const response = await invokeHandler(getProduct, {
      data: { id: okProduct.id },
      context: { requestContext: contextWithTransaction(createFakeTransaction(detailDataset)) },
    });

    expect(response).toMatchObject({ product: { id: okProduct.id } });
    expect(callsWith(add, "state")).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });
});

function dashboardProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    tenantId: TENANT_ID,
    userId: "user-1",
    name: "Bolo de Cacau",
    status: "active",
    currentPrice: "25",
    yieldQty: "1",
    taxRate: "0.1",
    yieldUnit: null,
    taxRegime: null,
    isDemo: false,
    notes: null,
    version: 0,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function dashboardInputs(overrides: Partial<DashboardInputs> = {}): DashboardInputs {
  return {
    productRows: [],
    expenseRows: [],
    ingredientRows: [],
    packagingRows: [],
    feeRows: [],
    marketRows: [],
    ...overrides,
  };
}

class FakeDashboardRepository implements DashboardRepository {
  constructor(private readonly result: DashboardInputs) {}

  async loadInputs(): Promise<DashboardInputs> {
    return this.result;
  }
}

class FakeSalesService implements SalesService {
  async create(): Promise<never> {
    throw new Error("NOT_IMPLEMENTED");
  }

  async revenue(): Promise<string> {
    return "0.0000";
  }

  async summaryForPeriod(): Promise<SalesSummary> {
    return { revenue: "0.0000", count: 0 };
  }

  async list(): Promise<never> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

describe("app.financial.states no dashboard", () => {
  it("emite exatamente um evento por produto, em todos os estados (sem duplicação)", async () => {
    const states = vi.spyOn(applicationMetrics.financialStates, "add");
    const repository = new FakeDashboardRepository(
      dashboardInputs({
        productRows: [
          dashboardProduct(),
          dashboardProduct({ id: undefined, currentPrice: "-1" }),
          dashboardProduct({ id: undefined, currentPrice: null }),
        ],
      }),
    );
    const service = new DefaultDashboardService(repository, new FakeSalesService());

    await service.getSummary(contextWithRole("owner"));

    expect(callsWith(states, "state")).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
      [1, { state: "invalid", engine_version: FINANCE_ENGINE_VERSION }],
      [1, { state: "incomplete", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });
});

function diagnosticContext(productsRows: ProductRow[]): RequestContext {
  return contextWithTransaction(createFakeTransaction({ ...dataset, products: productsRows }));
}

describe("app.financial.states no diagnóstico", () => {
  beforeEach(() => {
    expenseMocks.rows = [];
  });

  it("emite um único estado por view, no choke point do read model", async () => {
    const states = vi.spyOn(applicationMetrics.financialStates, "add");
    const diagnostic = vi.spyOn(applicationMetrics.diagnosticCalculationTotal, "add");

    const view = await getDiagnostic(diagnosticContext([okProduct]), {
      productId: okProduct.id,
      nonPercentageVariableUnitCost: null,
      targetContributionRate: null,
    });

    expect(view.currentStatus).toBe("ok");
    expect(view.engineVersion).toBe(FINANCE_ENGINE_VERSION);
    expect(callsWith(states, "state")).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
    expect(callsWith(diagnostic, "status")).toEqual([[1, { status: "ok" }]]);
  });

  it("emite um único estado invalid quando o cálculo do produto é inválido", async () => {
    const states = vi.spyOn(applicationMetrics.financialStates, "add");

    const view = await getDiagnostic(diagnosticContext([invalidProduct]), {
      productId: invalidProduct.id,
      nonPercentageVariableUnitCost: null,
      targetContributionRate: null,
    });

    expect(view.currentStatus).toBe("invalid");
    expect(callsWith(states, "state")).toEqual([
      [1, { state: "invalid", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("conta o status da view em app.diagnostic.calculation_total, não no estado do read model", async () => {
    expenseMocks.rows = [{ type: "fixa", amount: "não-numérico" }];
    const states = vi.spyOn(applicationMetrics.financialStates, "add");
    const diagnostic = vi.spyOn(applicationMetrics.diagnosticCalculationTotal, "add");

    const view = await getDiagnostic(diagnosticContext([okProduct]), {
      productId: okProduct.id,
      nonPercentageVariableUnitCost: null,
      targetContributionRate: null,
    });

    // Métricas do produto ok (break-even não é cálculo de produto); a view é
    // invalid porque `fixedExpenses` não é numérico.
    expect(view.currentStatus).toBe("invalid");
    expect(callsWith(states, "state")).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
    expect(callsWith(diagnostic, "status")).toEqual([[1, { status: "invalid" }]]);
  });
});
