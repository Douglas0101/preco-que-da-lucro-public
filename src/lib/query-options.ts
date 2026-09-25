import { queryOptions } from "@tanstack/react-query";
import { getChatHistory } from "@/lib/chat.functions";
import { getDashboardSummary, type DashboardPeriod } from "@/lib/dashboard.functions";
import { listExpenses } from "@/lib/expenses.functions";
import { listSimulations, runSimulation } from "@/lib/financial.functions";
import {
  listProductsWithMetrics,
  listPurchasePrices,
  listProducts,
} from "@/lib/products.functions";
import { listSales } from "@/lib/sales.functions";
import {
  AGGREGATE_STALE_TIME,
  OPERATIONAL_STALE_TIME,
  REALTIME_STALE_TIME,
} from "@/lib/query-stale-time";

// staleTime por natureza do dado (plano §17.5) — constantes vivem em
// query-stale-time.ts (módulo puro) para não açoar *.functions/zod no grafo
// inicial via router.tsx; reexportadas aqui por compatibilidade.
export { AGGREGATE_STALE_TIME, OPERATIONAL_STALE_TIME, REALTIME_STALE_TIME };

// staleTime fica EXPLÍCITO por query key (T4); o default global do QueryClient
// (router.tsx) é apenas o piso conservador OPERATIONAL_STALE_TIME. As
// invalidações pós-escrita continuam explícitas nos mutations.
const authenticatedQueryPolicy = {
  retry: false,
} as const;

export type FinancialSimulationInput = {
  price: string | null;
  unitCost: string | null;
  fixedExpenses: string | null;
  volume: string | null;
  taxRate: string | null;
  fees: Array<{ percentage: string | null }>;
  volumeSource: "real" | "manual_simulation" | "forecast" | "unknown";
};

export const queryKeys = {
  productsWithMetrics: () => ["products", "with-metrics"] as const,
  productsList: () => ["products", "list"] as const,
  expenses: () => ["expenses"] as const,
  dashboardSummary: (period: DashboardPeriod) => ["dashboard", "summary", period] as const,
  salesList: () => ["sales", "list"] as const,
  savedSimulations: () => ["simulations", "saved"] as const,
  purchasePrices: () => ["products", "purchase-prices"] as const,
  chatHistory: () => ["chat", "history"] as const,
  financialSimulation: (input: FinancialSimulationInput) =>
    [
      "financial-simulation",
      input.price,
      input.unitCost,
      input.fixedExpenses,
      input.volume,
      input.taxRate,
      input.fees.map((fee) => fee.percentage),
      input.volumeSource,
    ] as const,
} as const;

export function productsWithMetricsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.productsWithMetrics(),
    queryFn: () => listProductsWithMetrics(),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}

export function expensesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.expenses(),
    queryFn: () => listExpenses(),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}

export function dashboardSummaryQueryOptions(period: DashboardPeriod = "month") {
  return queryOptions({
    queryKey: queryKeys.dashboardSummary(period),
    queryFn: () => getDashboardSummary({ data: { period } }),
    ...authenticatedQueryPolicy,
    staleTime: AGGREGATE_STALE_TIME,
  });
}

export function productsListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.productsList(),
    queryFn: () => listProducts(),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}

export function salesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.salesList(),
    queryFn: () => listSales(),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}

export function purchasePricesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.purchasePrices(),
    queryFn: () => listPurchasePrices(),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}

export function chatHistoryQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.chatHistory(),
    queryFn: () => getChatHistory(),
    ...authenticatedQueryPolicy,
    staleTime: REALTIME_STALE_TIME,
  });
}

export function financialSimulationQueryOptions(input: FinancialSimulationInput) {
  return queryOptions({
    queryKey: queryKeys.financialSimulation(input),
    queryFn: () => runSimulation({ data: input }),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}

export function savedSimulationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.savedSimulations(),
    queryFn: () => listSimulations(),
    ...authenticatedQueryPolicy,
    staleTime: OPERATIONAL_STALE_TIME,
  });
}
