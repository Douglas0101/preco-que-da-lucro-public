import { and, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { z } from "zod";
import {
  expenses,
  marketPrices,
  productIngredients,
  productPackaging,
  products,
  salesFees,
} from "@/db/schema";
import {
  nonNegativeDecimalStringSchema,
  percentFractionSchema,
  positiveDecimalStringSchema,
  quantityUnitSchema,
  toDecimalString,
} from "@/lib/financial-values";
import type { RequestContext } from "@/lib/request-context";
import { purchasePriceService } from "@/server/services/purchase-price.service";

export interface ToolExecutionOutput extends Record<string, unknown> {
  result: Record<string, unknown>;
  state?: { currentProductId?: string };
}

/** Runtime contract for values that may cross the model/database boundary. */
export const toolExecutionOutputSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  state: z.object({ currentProductId: z.string().uuid().optional() }).optional(),
});

export type PreparedTool =
  | {
      ok: true;
      input: unknown;
      execute: () => Promise<ToolExecutionOutput>;
    }
  | { ok: false; code: "VALIDATION_ERROR" | "AUTHORIZATION_ERROR" };

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  prepare: (context: RequestContext, input: unknown) => PreparedTool;
}

function canMutate(context: RequestContext): boolean {
  return context.roles.some((role) => role === "owner" || role === "admin");
}

function defineTool<TSchema extends z.ZodType>(definition: {
  name: string;
  description: string;
  schema: TSchema;
  authorize?: (context: RequestContext) => boolean;
  execute: (context: RequestContext, input: z.output<TSchema>) => Promise<ToolExecutionOutput>;
}): RegisteredTool {
  const jsonSchema = z.toJSONSchema(definition.schema, { target: "draft-7", io: "input" });
  delete jsonSchema.$schema;
  return {
    name: definition.name,
    description: definition.description,
    parameters: jsonSchema,
    prepare(context, input) {
      const parsed = definition.schema.safeParse(input);
      if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };
      if (!(definition.authorize ?? canMutate)(context)) {
        return { ok: false, code: "AUTHORIZATION_ERROR" };
      }
      return {
        ok: true,
        input: parsed.data,
        execute: () => definition.execute(context, parsed.data),
      };
    },
  };
}

const id = z.string().uuid();
const name = z.string().trim().min(1).max(160);
const unit = quantityUnitSchema;
const money = nonNegativeDecimalStringSchema;
const quantity = positiveDecimalStringSchema;
const percentage = percentFractionSchema;

async function ensureProduct(context: RequestContext, productId: string): Promise<void> {
  // §9.2 — os tools de IA são adapter de persistência: estreitam o handle
  // neutro do contexto para a transação do driver onde executam SQL.
  const tx = context.transaction as DatabaseTransaction;
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.tenantId, context.tenantId), eq(products.id, productId)))
    .limit(1);
  if (!rows[0]) throw new Error("NOT_FOUND");
}

const DEFINITIONS = [
  defineTool({
    name: "create_product",
    description: "Cria um novo produto com o nome confirmado pelo usuário.",
    schema: z.object({ name }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      const [row] = await tx
        .insert(products)
        .values({
          tenantId: context.tenantId,
          userId: context.userId,
          name: input.name,
          yieldQty: null,
          taxRate: null,
        })
        .returning({ id: products.id, name: products.name });
      if (!row) throw new Error("DATABASE_ERROR");
      return {
        result: { productId: row.id, name: row.name },
        state: { currentProductId: row.id },
      };
    },
  }),
  defineTool({
    name: "add_ingredients",
    description: "Adiciona os ingredientes confirmados ao produto atual.",
    schema: z.object({
      product_id: id,
      ingredients: z
        .array(z.object({ name, used_qty: quantity, used_unit: unit }))
        .min(1)
        .max(50),
    }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      await ensureProduct(context, input.product_id);
      const rows = await tx
        .insert(productIngredients)
        .values(
          input.ingredients.map((ingredient) => ({
            tenantId: context.tenantId,
            userId: context.userId,
            productId: input.product_id,
            name: ingredient.name,
            usedQty: toDecimalString(ingredient.used_qty, 6),
            usedUnit: ingredient.used_unit,
          })),
        )
        .returning({ id: productIngredients.id, name: productIngredients.name });
      return { result: { ingredientCount: rows.length, ingredients: rows } };
    },
  }),
  defineTool({
    name: "set_ingredient_cost",
    description: "Registra preço e quantidade da embalagem de compra de um ingrediente.",
    schema: z.object({
      ingredient_id: id,
      package_price: money,
      package_qty: quantity,
      package_unit: unit,
    }),
    async execute(context, input) {
      const updated = await purchasePriceService.update(context, {
        kind: "ingredient",
        subjectId: input.ingredient_id,
        price: input.package_price,
        quantity: input.package_qty,
        unit: input.package_unit,
      });
      return { result: { ingredientId: updated.id, historyId: updated.historyId } };
    },
  }),
  defineTool({
    name: "set_yield",
    description: "Registra o rendimento confirmado da receita.",
    schema: z.object({ product_id: id, yield_qty: quantity, yield_unit: unit }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      const rows = await tx
        .update(products)
        .set({
          yieldQty: toDecimalString(input.yield_qty, 6),
          yieldUnit: input.yield_unit,
          version: sql`${products.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(products.tenantId, context.tenantId), eq(products.id, input.product_id)))
        .returning({ id: products.id });
      if (!rows[0]) throw new Error("NOT_FOUND");
      return { result: { productId: rows[0].id } };
    },
  }),
  defineTool({
    name: "add_packaging",
    description: "Adiciona uma embalagem ou material usado na venda.",
    schema: z.object({
      product_id: id,
      name,
      package_price: money,
      units_per_package: quantity,
    }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      await ensureProduct(context, input.product_id);
      const priceUpdatedAt = new Date();
      const [row] = await tx
        .insert(productPackaging)
        .values({
          tenantId: context.tenantId,
          userId: context.userId,
          productId: input.product_id,
          name: input.name,
          packagePrice: toDecimalString(input.package_price, 4),
          unitsPerPackage: toDecimalString(input.units_per_package, 6),
          priceUpdatedAt,
        })
        .returning({ id: productPackaging.id, name: productPackaging.name });
      if (!row) throw new Error("DATABASE_ERROR");
      const history = await purchasePriceService.append(context, {
        kind: "packaging",
        subjectId: row.id,
        price: input.package_price,
        quantity: input.units_per_package,
        unit: "unidade",
        validFrom: priceUpdatedAt,
      });
      return { result: { packaging: row, historyId: history.id } };
    },
  }),
  defineTool({
    name: "set_price_and_tax",
    description: "Registra preço atual, regime e alíquota efetiva confirmados.",
    schema: z.object({
      product_id: id,
      current_price: money,
      tax_regime: z.string().trim().min(1).max(80),
      tax_rate: percentage.optional(),
    }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      const rows = await tx
        .update(products)
        .set({
          currentPrice: toDecimalString(input.current_price, 4),
          taxRegime: input.tax_regime,
          taxRate: input.tax_rate === undefined ? null : toDecimalString(input.tax_rate, 6),
          version: sql`${products.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(products.tenantId, context.tenantId), eq(products.id, input.product_id)))
        .returning({ id: products.id });
      if (!rows[0]) throw new Error("NOT_FOUND");
      return { result: { productId: rows[0].id } };
    },
  }),
  defineTool({
    name: "add_fee",
    description: "Adiciona uma taxa percentual sobre a venda.",
    schema: z.object({ product_id: id, name, percentage }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      await ensureProduct(context, input.product_id);
      const [row] = await tx
        .insert(salesFees)
        .values({
          tenantId: context.tenantId,
          userId: context.userId,
          productId: input.product_id,
          name: input.name,
          percentage: toDecimalString(input.percentage, 6),
        })
        .returning({ id: salesFees.id, name: salesFees.name });
      if (!row) throw new Error("DATABASE_ERROR");
      return { result: { fee: row } };
    },
  }),
  defineTool({
    name: "set_market_price",
    description: "Registra referências de preço de mercado informadas pelo usuário.",
    schema: z
      .object({
        product_id: id,
        min_price: money.optional(),
        avg_price: money.optional(),
        max_price: money.optional(),
      })
      .refine(
        (value) =>
          value.min_price !== undefined ||
          value.avg_price !== undefined ||
          value.max_price !== undefined,
        { message: "Informe pelo menos uma referência de mercado." },
      ),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      await ensureProduct(context, input.product_id);
      const [row] = await tx
        .insert(marketPrices)
        .values({
          tenantId: context.tenantId,
          userId: context.userId,
          productId: input.product_id,
          minPrice: input.min_price === undefined ? null : toDecimalString(input.min_price, 4),
          avgPrice: input.avg_price === undefined ? null : toDecimalString(input.avg_price, 4),
          maxPrice: input.max_price === undefined ? null : toDecimalString(input.max_price, 4),
        })
        .returning({ id: marketPrices.id });
      if (!row) throw new Error("DATABASE_ERROR");
      return { result: { marketPriceId: row.id } };
    },
  }),
  defineTool({
    name: "add_expense",
    description: "Adiciona uma despesa periódica confirmada pelo usuário.",
    schema: z.object({
      name,
      amount: money,
      type: z.enum(["fixa", "variavel"]),
      category: z.string().trim().max(80).optional(),
    }),
    async execute(context, input) {
      const tx = context.transaction as DatabaseTransaction;
      const [row] = await tx
        .insert(expenses)
        .values({
          tenantId: context.tenantId,
          userId: context.userId,
          name: input.name,
          amount: toDecimalString(input.amount, 4),
          type: input.type,
          category: input.category ?? null,
        })
        .returning({ id: expenses.id, name: expenses.name });
      if (!row) throw new Error("DATABASE_ERROR");
      return { result: { expense: row } };
    },
  }),
  defineTool({
    name: "finish_product",
    description: "Confirma que a coleta dos dados do produto foi finalizada.",
    schema: z.object({ product_id: id }),
    async execute(context, input) {
      await ensureProduct(context, input.product_id);
      return {
        result: {
          productId: input.product_id,
          message: "Produto finalizado. Mostre ao usuário os próximos passos.",
        },
        state: { currentProductId: input.product_id },
      };
    },
  }),
] satisfies RegisteredTool[];

export const TOOL_REGISTRY = new Map(
  DEFINITIONS.map((definition) => [definition.name, definition]),
);

export const GATEWAY_TOOLS = DEFINITIONS.map((definition) => ({
  type: "function" as const,
  function: {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  },
}));

export type GatewayTool = (typeof GATEWAY_TOOLS)[number];

/** Readonly list of every registered tool name (used by the server FSM allowlist). */
export const REGISTRY_TOOL_NAMES: readonly string[] = DEFINITIONS.map(
  (definition) => definition.name,
);

/**
 * Tools that are meaningful without a product in conversational context
 * (plan §14.2). Every other tool is product-scoped and only offered once the
 * conversation has a confirmed currentProductId. This narrows what the model
 * can see per turn; runRegisteredTool's tenant/ownership checks remain the
 * actual authorization boundary.
 */
export const GLOBAL_TOOL_NAMES = new Set(["create_product", "add_expense"]);

export const PRODUCT_SCOPED_TOOL_NAMES = new Set(
  DEFINITIONS.map((definition) => definition.name).filter((name) => !GLOBAL_TOOL_NAMES.has(name)),
);

const GATEWAY_TOOLS_BY_NAME = new Map(GATEWAY_TOOLS.map((tool) => [tool.function.name, tool]));

/** Gateway tool list restricted to what the persisted conversation state allows. */
export function gatewayToolsForState(currentProductId: string | null | undefined) {
  const allowedNames = currentProductId
    ? DEFINITIONS.map((definition) => definition.name)
    : [...GLOBAL_TOOL_NAMES];
  return allowedNames
    .map((name) => GATEWAY_TOOLS_BY_NAME.get(name))
    .filter((tool) => tool !== undefined);
}
