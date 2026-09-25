import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { products, sales, salesItems, type Sale, type SaleItem } from "@/db/schema";
import { LIST_LIMITS } from "@/lib/list-limits";
import type { RequestContext } from "@/lib/request-context";

export interface SaleItemWrite {
  productId: string;
  quantity: string;
  unitPrice: string;
  totalAmount: string;
}

export interface SaleWrite {
  occurredAt: Date;
  grossAmount: string;
  netAmount: string;
  channel: string;
  items: readonly SaleItemWrite[];
}

export interface SalesSummary {
  /** Net revenue (net_amount) for the period, as a decimal string (0 when no sales). */
  revenue: string;
  /** Count of sales records in the period (factual, zero = no sales recorded). */
  count: number;
}

export interface SaleListRow {
  sale: Sale;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    quantity: string;
    unitPrice: string;
    totalAmount: string;
  }>;
}

export interface SalesRepository {
  create(context: RequestContext, input: SaleWrite): Promise<{ sale: Sale; items: SaleItem[] }>;
  revenue(context: RequestContext, range?: { from?: Date; to?: Date }): Promise<string>;
  summaryForPeriod(context: RequestContext, from: Date): Promise<SalesSummary>;
  list(
    context: RequestContext,
    range: { from?: Date; to?: Date; limit?: number },
  ): Promise<SaleListRow[]>;
}

export class DrizzleSalesRepository implements SalesRepository {
  async create(context: RequestContext, input: SaleWrite) {
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    const [sale] = await tx
      .insert(sales)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        occurredAt: input.occurredAt,
        grossAmount: input.grossAmount,
        netAmount: input.netAmount,
        channel: input.channel,
      })
      .returning();
    if (!sale) throw new Error("DATABASE_ERROR");

    const items = await tx
      .insert(salesItems)
      .values(
        input.items.map((item) => ({
          tenantId: context.tenantId,
          userId: context.userId,
          saleId: sale.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalAmount: item.totalAmount,
        })),
      )
      .returning();

    return { sale, items };
  }

  async revenue(context: RequestContext, range: { from?: Date; to?: Date } = {}) {
    const tx = context.transaction as DatabaseTransaction;
    const predicates = [eq(sales.tenantId, context.tenantId)];
    if (range.from) predicates.push(gte(sales.occurredAt, range.from));
    if (range.to) predicates.push(lte(sales.occurredAt, range.to));

    const [row] = await tx
      .select({ revenue: sql<string>`coalesce(sum(${sales.netAmount}), 0)` })
      .from(sales)
      .where(and(...predicates));
    return row?.revenue ?? "0.0000";
  }

  async summaryForPeriod(context: RequestContext, from: Date): Promise<SalesSummary> {
    const tx = context.transaction as DatabaseTransaction;
    const [row] = await tx
      .select({
        revenue: sql<string>`coalesce(sum(${sales.netAmount}), 0)`,
        count: sql<number>`count(${sales.id})::integer`,
      })
      .from(sales)
      .where(and(eq(sales.tenantId, context.tenantId), gte(sales.occurredAt, from)));
    if (!row) throw new Error("DATABASE_ERROR");
    return { revenue: row.revenue, count: row.count };
  }

  async list(
    context: RequestContext,
    range: { from?: Date; to?: Date; limit?: number } = {},
  ): Promise<SaleListRow[]> {
    const tx = context.transaction as DatabaseTransaction;
    const limit = Math.min(Math.max(range.limit ?? LIST_LIMITS.sales, 1), LIST_LIMITS.sales);
    const predicates = [eq(sales.tenantId, context.tenantId)];
    if (range.from) predicates.push(gte(sales.occurredAt, range.from));
    if (range.to) predicates.push(lte(sales.occurredAt, range.to));

    const saleRows = await tx
      .select()
      .from(sales)
      .where(and(...predicates))
      .orderBy(desc(sales.occurredAt), desc(sales.createdAt))
      .limit(limit);
    if (saleRows.length === 0) return [];

    const itemRows = await tx
      .select({
        id: salesItems.id,
        saleId: salesItems.saleId,
        productId: salesItems.productId,
        productName: products.name,
        quantity: salesItems.quantity,
        unitPrice: salesItems.unitPrice,
        totalAmount: salesItems.totalAmount,
      })
      .from(salesItems)
      .innerJoin(products, eq(salesItems.productId, products.id))
      .where(
        and(
          eq(salesItems.tenantId, context.tenantId),
          inArray(
            salesItems.saleId,
            saleRows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(salesItems.createdAt));

    const itemsBySale = new Map<string, SaleListRow["items"]>();
    for (const row of itemRows) {
      const existing = itemsBySale.get(row.saleId) ?? [];
      existing.push({
        id: row.id,
        productId: row.productId,
        productName: row.productName,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        totalAmount: row.totalAmount,
      });
      itemsBySale.set(row.saleId, existing);
    }
    return saleRows.map((sale) => ({ sale, items: itemsBySale.get(sale.id) ?? [] }));
  }
}

export const salesRepository = new DrizzleSalesRepository();
