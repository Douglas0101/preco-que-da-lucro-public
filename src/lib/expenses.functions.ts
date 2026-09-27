import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { expenses } from "@/db/schema";
import {
  decimalStringSchema,
  nonNegativeDecimalStringSchema,
  toDecimalString,
} from "@/lib/financial-values";
import { optimisticVersionSchema } from "@/lib/optimistic-version";
import { outputSchema } from "@/lib/output-contract";
import type { RequestContext } from "@/lib/request-context";
import { requireDatabaseAuth } from "@/middleware/request-context";
import { expenseService } from "@/server/services/expense.service";

const uuid = z.string().uuid();
const expenseFields = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().max(80).optional().nullable(),
  amount: nonNegativeDecimalStringSchema,
  type: z.enum(["fixa", "variavel"]),
  periodicity: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

/** Contrato de criação: sem `id`/`version` (o banco inicia em 0). */
export const createExpenseInput = expenseFields;

/** Contrato de atualização: CAS otimista exige `id` + `version` correntes. */
export const updateExpenseInput = expenseFields.extend({
  id: uuid,
  version: optimisticVersionSchema,
});

const legacyExpenseInput = expenseFields
  .extend({
    id: uuid.optional(),
    version: optimisticVersionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.id && value.version === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "Atualização exige a versão corrente da despesa.",
      });
    }
    if (!value.id && value.version !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "Versão só se aplica a atualização com id.",
      });
    }
  });

type ExpenseFields = z.output<typeof expenseFields>;

function mapExpense(row: typeof expenses.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    tenant_id: row.tenantId,
    name: row.name,
    category: row.category,
    amount: row.amount,
    type: row.type,
    periodicity: row.periodicity,
    is_demo: row.isDemo,
    notes: row.notes,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Contratos de saída das server functions de despesa (DBT-25). O `amount` é
 * NUMERIC(19,4) do Postgres — string decimal canônica, nunca número — e o
 * `satisfies` prova em tempo de compilação que o schema bate com o tipo real
 * que o handler devolve.
 */
const expenseViewOutput = z.object({
  id: z.string(),
  user_id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  amount: decimalStringSchema,
  type: z.string(),
  periodicity: z.string(),
  is_demo: z.boolean(),
  notes: z.string().nullable(),
  version: z.int(),
  created_at: z.string(),
  updated_at: z.string(),
}) satisfies z.ZodType<ReturnType<typeof mapExpense>>;

const expensesListOutput = z.array(expenseViewOutput);

/** Totais de despesa: somas do banco (string decimal) + contagem de produtos. */
const expenseTotalsOutput = z.object({
  fixed: decimalStringSchema,
  variable: decimalStringSchema,
  /** Contagem de produtos ativos: inteiro do banco, não valor monetário. */
  productCount: z.int().nonnegative(),
}) satisfies z.ZodType<Awaited<ReturnType<typeof expenseService.totals>>>;

export const listExpenses = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const rows = await expenseService.list(context.requestContext);
    return outputSchema(expensesListOutput, "expenses.listExpenses", rows.map(mapExpense));
  });

function toExpenseWrite(data: ExpenseFields) {
  return {
    name: data.name,
    category: data.category ?? null,
    amount: toDecimalString(data.amount, 4),
    type: data.type,
    periodicity: data.periodicity ?? "mensal",
    notes: data.notes ?? null,
  };
}

async function createExpenseWrite(request: RequestContext, data: ExpenseFields) {
  return mapExpense(await expenseService.save(request, toExpenseWrite(data)));
}

async function updateExpenseWrite(
  request: RequestContext,
  data: z.output<typeof updateExpenseInput>,
) {
  return mapExpense(
    await expenseService.save(request, {
      id: data.id,
      version: data.version,
      ...toExpenseWrite(data),
    }),
  );
}

export const createExpense = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => createExpenseInput.parse(input))
  .handler(async ({ data, context }) => createExpenseWrite(context.requestContext, data));

export const updateExpense = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => updateExpenseInput.parse(input))
  .handler(async ({ data, context }) => updateExpenseWrite(context.requestContext, data));

/** Dispatcher legado: sem `id` cria; com `id` + `version` atualiza via CAS. */
export const upsertExpense = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => legacyExpenseInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    if (!data.id) return createExpenseWrite(request, data);
    return updateExpenseWrite(request, updateExpenseInput.parse(data));
  });

export const deleteExpense = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    await expenseService.remove(request, data.id);
    return { ok: true };
  });

export const getTotals = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const totals = await expenseService.totals(context.requestContext);
    return outputSchema(expenseTotalsOutput, "expenses.getTotals", totals);
  });
