import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { listProductsWithMetrics } from "@/lib/products.functions";
import { loadDashboardInputs } from "@/server/repositories/dashboard.repository";
import type { RequestContext } from "@/lib/request-context";
import {
  chatHistoryQueryOptions,
  dashboardSummaryQueryOptions,
  financialSimulationQueryOptions,
  queryKeys,
  type FinancialSimulationInput,
} from "@/lib/query-options";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    server: (handler: unknown) => handler,
  }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    };
    return builder;
  },
}));

const simulationInput: FinancialSimulationInput = {
  price: "10",
  unitCost: "4",
  fixedExpenses: "100",
  volume: "20",
  taxRate: "0.1",
  fees: [{ percentage: "0.02" }],
  volumeSource: "manual_simulation",
};

interface FakeQuery {
  from(table: unknown): FakeQuery;
  where(...conditions: unknown[]): FakeQuery;
  orderBy(...orders: unknown[]): FakeQuery;
  limit(count: number): FakeQuery;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

async function runDashboardReadModel(productCount: number) {
  let queryCount = 0;
  const transaction = {
    select() {
      const queryIndex = queryCount++;
      const query: FakeQuery = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (onfulfilled, onrejected) => {
          const rows =
            queryIndex === 0
              ? Array.from({ length: productCount }, (_, index) => ({ id: `product-${index}` }))
              : [];
          return Promise.resolve(rows).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  } as unknown as RequestContext["transaction"];

  const result = await loadDashboardInputs({
    tenantId: "tenant-test",
    transaction,
  } as RequestContext);
  return { queryCount, result };
}

async function runProductsReadModel(productCount: number) {
  let queryCount = 0;
  const productRows = Array.from({ length: productCount }, (_, index) => ({
    id: `product-${index}`,
    tenantId: "tenant-test",
    userId: "user-test",
    name: `Product ${index}`,
    status: "draft",
    currentPrice: null,
    yieldQty: null,
    yieldUnit: null,
    taxRegime: null,
    taxRate: null,
    isDemo: false,
    notes: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }));
  const transaction = {
    select() {
      const query: FakeQuery = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (onfulfilled, onrejected) => {
          const queryIndex = queryCount++;
          const rows = queryIndex === 0 ? productRows : [];
          return Promise.resolve(rows).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
    execute: async () => {
      queryCount++;
      return { rows: [] };
    },
  } as unknown as RequestContext["transaction"];

  const result = (await (
    listProductsWithMetrics as unknown as (input: {
      context: { requestContext: RequestContext };
    }) => Promise<unknown>
  )({
    context: {
      requestContext: {
        tenantId: "tenant-test",
        transaction,
      } as RequestContext,
    },
  })) as Array<unknown>;
  return { queryCount, result };
}

describe("query keys e política de cache financeira", () => {
  it("gera a mesma chave para a mesma simulação e inclui todos os campos relevantes", () => {
    expect(queryKeys.financialSimulation({ ...simulationInput })).toEqual(
      queryKeys.financialSimulation({ ...simulationInput }),
    );
  });

  it("diferencia mudanças em cada campo relevante da simulação", () => {
    const variants: FinancialSimulationInput[] = [
      { ...simulationInput, price: "11" },
      { ...simulationInput, unitCost: "5" },
      { ...simulationInput, fixedExpenses: "101" },
      { ...simulationInput, volume: "21" },
      { ...simulationInput, taxRate: "0.11" },
      { ...simulationInput, fees: [{ percentage: "0.03" }] },
      { ...simulationInput, volumeSource: "forecast" },
    ];
    const baseKey = queryKeys.financialSimulation(simulationInput);

    for (const variant of variants) {
      expect(queryKeys.financialSimulation(variant)).not.toEqual(baseKey);
    }
  });

  it("mantém a simulação no staleTime operacional e sem retry das queries autenticadas", () => {
    const options = financialSimulationQueryOptions(simulationInput);

    expect(options.staleTime).toBe(30_000);
    expect(options.retry).toBe(false);
  });

  it("diferencia staleTime por natureza do dado (plano §17.5)", () => {
    expect(dashboardSummaryQueryOptions().staleTime).toBe(60_000);
    expect(chatHistoryQueryOptions().staleTime).toBe(0);
    expect(dashboardSummaryQueryOptions().retry).toBe(false);
    expect(chatHistoryQueryOptions().retry).toBe(false);
  });

  it("invalida a coleção de produtos sem invalidar a simulação", () => {
    const queryClient = new QueryClient();
    const productsKey = queryKeys.productsWithMetrics();
    const simulationKey = queryKeys.financialSimulation(simulationInput);

    queryClient.setQueryData(productsKey, [{ product: { id: "product-1" } }]);
    queryClient.setQueryData(simulationKey, { status: "ok" });
    queryClient.invalidateQueries({ queryKey: productsKey });

    expect(queryClient.getQueryState(productsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(simulationKey)?.isInvalidated).toBe(false);
  });

  it("mantém número fixo de queries do read model do dashboard", async () => {
    const oneProduct = await runDashboardReadModel(1);
    const threeProducts = await runDashboardReadModel(3);

    expect(oneProduct.result.productRows).toHaveLength(1);
    expect(threeProducts.result.productRows).toHaveLength(3);
    expect(oneProduct.queryCount).toBe(6);
    expect(threeProducts.queryCount).toBe(oneProduct.queryCount);
  });

  it("mantém número fixo de queries no read model batch de produtos", async () => {
    const oneProduct = await runProductsReadModel(1);
    const threeProducts = await runProductsReadModel(3);

    expect(oneProduct.result).toHaveLength(1);
    expect(threeProducts.result).toHaveLength(3);
    expect(oneProduct.queryCount).toBe(2);
    expect(threeProducts.queryCount).toBe(oneProduct.queryCount);
  });
});
