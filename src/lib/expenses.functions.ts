import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { expenses } from "@/db/schema";
import { nonNegativeDecimalStringSchema, toDecimalString } from "@/lib/financial-values";
import { optimisticVersionSchema } from "@/lib/optimistic-version";
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

export const listExpenses = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const rows = await expenseService.list(context.requestContext);
    return rows.map(mapExpense);
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
    return expenseService.totals(context.requestContext);
  });
