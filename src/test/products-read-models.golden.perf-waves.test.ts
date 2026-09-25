import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  marketPrices,
  productIngredients,
  productPackaging,
  products,
  salesFees,
} from "@/db/schema";
import {
  listProducts,
  listProductsWithMetrics,
  listPurchasePrices,
} from "@/lib/products.functions";
import type { RequestContext } from "@/lib/request-context";

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

const TENANT_ID = "aaaaaaa1-0000-4000-8000-000000000001";
const CORRELATION_ID = "aaaaaaa2-0000-4000-8000-000000000002";

type ProductRow = typeof products.$inferSelect;
type IngredientRow = typeof productIngredients.$inferSelect;
type PackagingRow = typeof productPackaging.$inferSelect;
type FeeRow = typeof salesFees.$inferSelect;
type MarketRow = typeof marketPrices.$inferSelect;

interface Dataset {
  products: ProductRow[];
  ingredients: IngredientRow[];
  packaging: PackagingRow[];
  fees: FeeRow[];
  market: MarketRow[];
}

const fullDataset: Dataset = {
  products: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Bolo de Cacau",
      status: "active",
      currentPrice: "25.5000",
      yieldQty: "12.000000",
      yieldUnit: "unidades",
      taxRegime: "simples nacional",
      taxRate: "0.060000",
      isDemo: false,
      notes: "receita da vó",
      version: 0,
      archivedAt: null,
      createdAt: new Date("2026-01-03T10:00:00.000Z"),
      updatedAt: new Date("2026-01-03T10:00:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Pão Artesanal",
      status: "draft",
      currentPrice: null,
      yieldQty: null,
      yieldUnit: null,
      taxRegime: null,
      taxRate: null,
      isDemo: true,
      notes: null,
      version: 0,
      archivedAt: null,
      createdAt: new Date("2026-01-02T10:00:00.000Z"),
      updatedAt: new Date("2026-01-02T10:00:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Geleia sem filhos",
      status: "ready",
      currentPrice: "18.0000",
      yieldQty: "20.000000",
      yieldUnit: "potinhos",
      taxRegime: null,
      taxRate: null,
      isDemo: false,
      notes: null,
      version: 0,
      archivedAt: null,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
      updatedAt: new Date("2026-01-01T10:00:00.000Z"),
    },
  ],
  ingredients: [
    {
      id: "00000000-0000-4000-8000-000000000011",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Farinha",
      usedQty: "1.000000",
      usedUnit: "kg",
      packagePrice: "8.9000",
      packageQty: "5.000000",
      packageUnit: "kg",
      conversionFactor: "1.00000000",
      priceUpdatedAt: new Date("2026-01-02T12:00:00.000Z"),
      createdAt: new Date("2026-01-03T10:05:00.000Z"),
      updatedAt: new Date("2026-01-03T10:05:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000012",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Ovo",
      usedQty: "3.000000",
      usedUnit: "unidade",
      packagePrice: null,
      packageQty: null,
      packageUnit: null,
      conversionFactor: null,
      priceUpdatedAt: null,
      createdAt: new Date("2026-01-03T10:06:00.000Z"),
      updatedAt: new Date("2026-01-03T10:06:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000013",
      productId: "00000000-0000-4000-8000-000000000002",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Fermento",
      usedQty: "0.010000",
      usedUnit: "kg",
      packagePrice: "2.5000",
      packageQty: "0.500000",
      packageUnit: "kg",
      conversionFactor: "0.50000000",
      priceUpdatedAt: new Date("2026-01-01T09:00:00.000Z"),
      createdAt: new Date("2026-01-02T10:05:00.000Z"),
      updatedAt: new Date("2026-01-02T10:05:00.000Z"),
    },
  ],
  packaging: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Caixa",
      packagePrice: "1.2000",
      unitsPerPackage: "10.000000",
      priceUpdatedAt: new Date("2026-01-02T12:00:00.000Z"),
      createdAt: new Date("2026-01-03T10:07:00.000Z"),
      updatedAt: new Date("2026-01-03T10:07:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000022",
      productId: "00000000-0000-4000-8000-000000000002",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Saco kraft",
      packagePrice: "0.3000",
      unitsPerPackage: "1.000000",
      priceUpdatedAt: null,
      createdAt: new Date("2026-01-02T10:07:00.000Z"),
      updatedAt: new Date("2026-01-02T10:07:00.000Z"),
    },
  ],
  fees: [
    {
      id: "00000000-0000-4000-8000-000000000031",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Cartão",
      percentage: "0.029900",
      createdAt: new Date("2026-01-03T10:08:00.000Z"),
      updatedAt: new Date("2026-01-03T10:08:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000032",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Imposto",
      percentage: "0.120000",
      createdAt: new Date("2026-01-03T10:09:00.000Z"),
      updatedAt: new Date("2026-01-03T10:09:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000033",
      productId: "00000000-0000-4000-8000-000000000002",
      tenantId: TENANT_ID,
      userId: "user-1",
      name: "Delivery",
      percentage: "0.050000",
      createdAt: new Date("2026-01-02T10:08:00.000Z"),
      updatedAt: new Date("2026-01-02T10:08:00.000Z"),
    },
  ],
  market: [
    {
      id: "00000000-0000-4000-8000-000000000041",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      minPrice: "20.0000",
      avgPrice: "24.0000",
      maxPrice: "30.0000",
      createdAt: new Date("2026-01-05T08:00:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000042",
      productId: "00000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      userId: "user-1",
      minPrice: null,
      avgPrice: null,
      maxPrice: null,
      createdAt: new Date("2026-01-04T08:00:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000043",
      productId: "00000000-0000-4000-8000-000000000002",
      tenantId: TENANT_ID,
      userId: "user-1",
      minPrice: "5.0000",
      avgPrice: "6.0000",
      maxPrice: "8.0000",
      createdAt: new Date("2026-01-04T08:00:00.000Z"),
    },
  ],
};

const emptyDataset: Dataset = {
  products: [] as ProductRow[],
  ingredients: [] as IngredientRow[],
  packaging: [] as PackagingRow[],
  fees: [] as FeeRow[],
  market: [] as MarketRow[],
};

function createFakeTransaction(dataset: Dataset) {
  const dialect = new PgDialect();
  const queryBuilder = new QueryBuilder();
  let queryCount = 0;
  const byNameAsc = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, "pt-BR");
  const unionRow = (branch: number, kind: string, row: object, index: number) => ({
    branch,
    ord: index + 1,
    kind,
    ...row,
  });
  const rowsForTable = (renderedSql: string): object[] => {
    const nameOrdered = /order by [^)]*"name"/.test(renderedSql);
    if (renderedSql.includes('from "products"')) return dataset.products;
    if (renderedSql.includes('from "product_ingredients"'))
      return nameOrdered ? [...dataset.ingredients].sort(byNameAsc) : dataset.ingredients;
    if (renderedSql.includes('from "product_packaging"'))
      return nameOrdered ? [...dataset.packaging].sort(byNameAsc) : dataset.packaging;
    if (renderedSql.includes('from "sales_fees"')) return dataset.fees;
    if (renderedSql.includes('from "market_prices"')) return dataset.market;
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
                queryCount += 1;
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
      queryCount += 1;
      const rendered = dialect.sqlToQuery(fragment).sql;
      const nameOrdered = /order by [^)]*"name"/.test(rendered);
      const rows: Record<string, unknown>[] = [];
      if (rendered.includes('from "product_ingredients"')) {
        const ordered = nameOrdered
          ? [...dataset.ingredients].sort(byNameAsc)
          : dataset.ingredients;
        rows.push(...ordered.map((row, index) => unionRow(1, "ingredient", row, index)));
      }
      if (rendered.includes('from "product_packaging"')) {
        const ordered = nameOrdered ? [...dataset.packaging].sort(byNameAsc) : dataset.packaging;
        rows.push(...ordered.map((row, index) => unionRow(2, "packaging", row, index)));
      }
      if (rendered.includes('from "sales_fees"')) {
        rows.push(...dataset.fees.map((row, index) => unionRow(3, "fee", row, index)));
      }
      if (rendered.includes('from "market_prices"')) {
        rows.push(...dataset.market.map((row, index) => unionRow(4, "market", row, index)));
      }
      return { rows };
    },
  };
  return {
    transaction: transaction as unknown as RequestContext["transaction"],
    queryCount: () => queryCount,
  };
}

async function invokeHandler(
  handler: unknown,
  dataset: Dataset,
): Promise<{ response: unknown; queryCount: () => number }> {
  const fake = createFakeTransaction(dataset);
  const response = await (
    handler as unknown as (input: {
      context: { requestContext: RequestContext };
    }) => Promise<unknown>
  )({
    context: {
      requestContext: {
        userId: "user-1",
        tenantId: TENANT_ID,
        roles: ["owner"],
        correlationId: CORRELATION_ID,
        signal: new AbortController().signal,
        transaction: fake.transaction,
      } satisfies RequestContext,
    },
  });
  return { response, queryCount: fake.queryCount };
}

const FIXTURE_PATH = join(
  process.cwd(),
  "src/test/fixtures/products-read-models.perf-waves.golden.json",
);

async function buildSnapshot() {
  const withMetrics = await invokeHandler(listProductsWithMetrics, fullDataset);
  const productsOnly = await invokeHandler(listProducts, fullDataset);
  const purchasePrices = await invokeHandler(listPurchasePrices, fullDataset);
  const emptyWithMetrics = await invokeHandler(listProductsWithMetrics, emptyDataset);
  const emptyPurchasePrices = await invokeHandler(listPurchasePrices, emptyDataset);
  return {
    listProductsWithMetrics: withMetrics.response,
    listProducts: productsOnly.response,
    listPurchasePrices: purchasePrices.response,
    empty: {
      listProductsWithMetrics: emptyWithMetrics.response,
      listPurchasePrices: emptyPurchasePrices.response,
    },
  };
}

describe("T2 perf-waves: golden de leituras consolidadas de produtos", () => {
  it("mantém paridade exata da resposta JSON (fixture capturada antes da consolidação)", async () => {
    const current = await buildSnapshot();
    if (!existsSync(FIXTURE_PATH)) {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      console.warn("golden fixture capturada; rode novamente para validar a paridade");
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;
    expect(current).toEqual(expected);
  });

  it("loadProductReadModels executa no máximo 2 queries por invocação", async () => {
    const { queryCount } = await invokeHandler(listProductsWithMetrics, fullDataset);
    expect(queryCount()).toBe(2);
  });

  it("listPurchasePrices executa no máximo 2 queries por invocação", async () => {
    const { queryCount } = await invokeHandler(listPurchasePrices, fullDataset);
    expect(queryCount()).toBe(2);
  });

  it("lista vazia de produtos executa apenas a query de produtos", async () => {
    const { queryCount, response } = await invokeHandler(listProductsWithMetrics, emptyDataset);
    expect(queryCount()).toBe(1);
    expect(response).toEqual([]);
    const purchase = await invokeHandler(listPurchasePrices, emptyDataset);
    expect(purchase.queryCount()).toBe(1);
    expect(purchase.response).toEqual({ products: [], ingredients: [], packaging: [] });
  });

  it("snapshot cobre produtos, filhos e primeiro preço de mercado por produto", async () => {
    const snapshot = await buildSnapshot();
    const readModels = snapshot.listProductsWithMetrics as Array<{
      product: { id: string };
      ingredients: unknown[];
      market: { id: string } | null;
    }>;
    expect(readModels).toHaveLength(3);
    const bolo = readModels.find((row) => row.product.id === fullDataset.products[0].id);
    expect(bolo?.ingredients).toHaveLength(2);
    expect(bolo?.market?.id).toBe(fullDataset.market[0].id);
  });
});
