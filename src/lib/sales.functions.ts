import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireDatabaseAuth } from "@/middleware/request-context";
import { ApplicationError } from "@/lib/api-error";
import { decimalStringSchema, nonNegativeDecimalStringSchema } from "@/lib/financial-values";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { salesService } from "@/server/services/sales.service";

const saleItemInput = z
  .object({
    product_id: z.string().uuid(),
    quantity: decimalStringSchema,
    unit_price: nonNegativeDecimalStringSchema,
  })
  .strict();

const createSaleInput = z
  .object({
    occurred_at: z.string().datetime({ offset: true }),
    channel: z.string().trim().min(1).max(40),
    net_amount: nonNegativeDecimalStringSchema.optional(),
    items: z.array(saleItemInput).min(1).max(100),
  })
  .strict();

/**
 * Business validation errors raised by the service use non-API codes; expose
 * them as VALIDATION_ERROR (400, non retryable) instead of INTERNAL_ERROR.
 */
function validateBusinessError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("SALE_") || message.startsWith("INVALID_SALE_")) {
    throw new ApplicationError("VALIDATION_ERROR", { cause: error, message });
  }
  throw error;
}

function mapSaleItem(item: {
  id: string;
  productId: string;
  productName?: string | null;
  quantity: string;
  unitPrice: string;
  totalAmount: string;
}) {
  return {
    id: item.id,
    product_id: item.productId,
    product_name: item.productName ?? null,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_amount: item.totalAmount,
  };
}

export const createSale = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => createSaleInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    try {
      const result = await salesService.create(request, {
        occurredAt: new Date(data.occurred_at),
        channel: data.channel,
        netAmount: data.net_amount,
        items: data.items.map((item) => ({
          productId: item.product_id,
          quantity: item.quantity,
          unitPrice: item.unit_price,
        })),
      });
      applicationMetrics.salesCreatedTotal.add(1);
      return {
        ok: true as const,
        sale: {
          id: result.sale.id,
          occurred_at: result.sale.occurredAt.toISOString(),
          gross_amount: result.sale.grossAmount,
          net_amount: result.sale.netAmount,
          channel: result.sale.channel,
          created_at: result.sale.createdAt.toISOString(),
          items: result.items.map(mapSaleItem),
        },
      };
    } catch (error) {
      validateBusinessError(error);
    }
  });

const listSalesInput = z.object({ limit: z.number().int().min(1).max(50).optional() }).optional();

export const listSales = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => listSalesInput.parse(input))
  .handler(async ({ context }) => {
    const rows = await salesService.list(context.requestContext, { limit: 50 });
    return rows.map((row) => ({
      id: row.sale.id,
      occurred_at: row.sale.occurredAt.toISOString(),
      gross_amount: row.sale.grossAmount,
      net_amount: row.sale.netAmount,
      channel: row.sale.channel,
      created_at: row.sale.createdAt.toISOString(),
      items: row.items.map(mapSaleItem),
    }));
  });
