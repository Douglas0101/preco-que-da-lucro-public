import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import {
  expenses,
  marketPrices,
  productIngredients,
  productPackaging,
  products,
  salesFees,
  type Expense,
  type Product,
} from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

/** Tenant-scoped rows consumed by the dashboard read model. */
export interface DashboardInputs {
  productRows: Product[];
  expenseRows: Expense[];
  ingredientRows: Array<typeof productIngredients.$inferSelect>;
  packagingRows: Array<typeof productPackaging.$inferSelect>;
  feeRows: Array<typeof salesFees.$inferSelect>;
  marketRows: Array<typeof marketPrices.$inferSelect>;
}

export interface DashboardRepository {
  loadInputs(context: RequestContext): Promise<DashboardInputs>;
}

export class DrizzleDashboardRepository implements DashboardRepository {
  /**
   * Read model for the dashboard.  All predicates include tenant_id even though
   * PostgreSQL RLS is enabled, keeping repository methods safe when called from
   * admin tooling and making the tenant boundary explicit in every query.
   */
  async loadInputs(context: RequestContext): Promise<DashboardInputs> {
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    const productRows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), isNull(products.archivedAt)))
      .orderBy(desc(products.createdAt));
    const productIds = productRows.map((row) => row.id);

    const [expenseRows, ingredientRows, packagingRows, feeRows, marketRows] = await Promise.all([
      tx
        .select()
        .from(expenses)
        .where(eq(expenses.tenantId, context.tenantId))
        .orderBy(desc(expenses.createdAt)),
      productIds.length
        ? tx
            .select()
            .from(productIngredients)
            .where(
              and(
                eq(productIngredients.tenantId, context.tenantId),
                inArray(productIngredients.productId, productIds),
              ),
            )
        : Promise.resolve([]),
      productIds.length
        ? tx
            .select()
            .from(productPackaging)
            .where(
              and(
                eq(productPackaging.tenantId, context.tenantId),
                inArray(productPackaging.productId, productIds),
              ),
            )
        : Promise.resolve([]),
      productIds.length
        ? tx
            .select()
            .from(salesFees)
            .where(
              and(
                eq(salesFees.tenantId, context.tenantId),
                inArray(salesFees.productId, productIds),
              ),
            )
        : Promise.resolve([]),
      productIds.length
        ? tx
            .select()
            .from(marketPrices)
            .where(
              and(
                eq(marketPrices.tenantId, context.tenantId),
                inArray(marketPrices.productId, productIds),
              ),
            )
            .orderBy(desc(marketPrices.createdAt))
        : Promise.resolve([]),
    ]);

    return { productRows, expenseRows, ingredientRows, packagingRows, feeRows, marketRows };
  }
}

export const dashboardRepository: DashboardRepository = new DrizzleDashboardRepository();

/**
 * Adapter kept for existing importers (query-performance and perf-waves
 * suites): the singleton repository remains the single query implementation.
 */
export function loadDashboardInputs(context: RequestContext): Promise<DashboardInputs> {
  return dashboardRepository.loadInputs(context);
}
