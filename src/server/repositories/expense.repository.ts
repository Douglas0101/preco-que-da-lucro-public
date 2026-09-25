import { and, desc, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { expenses, products, type Expense } from "@/db/schema";
import { LIST_LIMITS } from "@/lib/list-limits";
import type { RequestContext } from "@/lib/request-context";

export interface ExpenseWrite {
  id?: string;
  /** Versão esperada para CAS otimista; obrigatória quando `id` está presente. */
  version?: number;
  name: string;
  category: string | null;
  amount: string;
  type: "fixa" | "variavel";
  periodicity: string;
  notes: string | null;
}

export interface ExpenseTotals {
  fixed: string;
  variable: string;
  productCount: number;
}

export interface ExpenseRepository {
  list(context: RequestContext): Promise<Expense[]>;
  save(context: RequestContext, input: ExpenseWrite): Promise<Expense>;
  remove(context: RequestContext, id: string): Promise<void>;
  totals(context: RequestContext): Promise<ExpenseTotals>;
}

export class DrizzleExpenseRepository implements ExpenseRepository {
  async list(context: RequestContext): Promise<Expense[]> {
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    return tx
      .select()
      .from(expenses)
      .where(eq(expenses.tenantId, context.tenantId))
      .orderBy(desc(expenses.createdAt))
      .limit(LIST_LIMITS.expenses);
  }

  async save(context: RequestContext, input: ExpenseWrite): Promise<Expense> {
    const tx = context.transaction as DatabaseTransaction;
    const values = {
      name: input.name,
      category: input.category,
      amount: input.amount,
      type: input.type,
      periodicity: input.periodicity,
      notes: input.notes,
      updatedAt: new Date(),
    };

    if (!input.id) {
      const rows = await tx
        .insert(expenses)
        .values({ tenantId: context.tenantId, userId: context.userId, ...values })
        .returning();
      if (!rows[0]) throw new Error("DATABASE_ERROR");
      return rows[0];
    }

    if (input.version === undefined) throw new Error("VALIDATION_ERROR");
    const rows = await tx
      .update(expenses)
      .set({ ...values, version: sql`${expenses.version} + 1` })
      .where(
        and(
          eq(expenses.tenantId, context.tenantId),
          eq(expenses.id, input.id),
          eq(expenses.version, input.version),
        ),
      )
      .returning();
    if (rows[0]) return rows[0];

    const existing = await tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.tenantId, context.tenantId), eq(expenses.id, input.id)))
      .limit(1);
    throw new Error(existing[0] ? "CONFLICT" : "NOT_FOUND");
  }

  async remove(context: RequestContext, id: string): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    const rows = await tx
      .delete(expenses)
      .where(and(eq(expenses.tenantId, context.tenantId), eq(expenses.id, id)))
      .returning({ id: expenses.id });
    if (!rows.length) throw new Error("NOT_FOUND");
  }

  async totals(context: RequestContext): Promise<ExpenseTotals> {
    const tx = context.transaction as DatabaseTransaction;
    const [totals] = await tx
      .select({
        fixed: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.type} = 'fixa'), 0)`,
        variable: sql<string>`coalesce(sum(${expenses.amount}) filter (where ${expenses.type} = 'variavel'), 0)`,
        productCount: sql<number>`(
          select count(*)::integer
          from ${products}
          where ${products.tenantId} = ${context.tenantId}
            and ${products.archivedAt} is null
        )`,
      })
      .from(expenses)
      .where(eq(expenses.tenantId, context.tenantId));

    if (!totals) throw new Error("DATABASE_ERROR");
    return totals;
  }
}

export const expenseRepository = new DrizzleExpenseRepository();
