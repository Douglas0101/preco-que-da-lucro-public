import Decimal from "decimal.js";
import { assertTenantMutationAuthorized, type RequestContext } from "@/lib/request-context";
import { toDecimalString } from "@/lib/financial-values";
import {
  salesRepository,
  type SalesRepository,
  type SalesSummary,
  type SaleWrite,
} from "@/server/repositories/sales.repository";

export interface SaleDraft {
  occurredAt: Date;
  channel: string;
  netAmount?: string;
  items: ReadonlyArray<{
    productId: string;
    quantity: string;
    unitPrice: string;
  }>;
}

export interface SalesService {
  create(context: RequestContext, input: SaleDraft): ReturnType<SalesRepository["create"]>;
  revenue(context: RequestContext, range?: { from?: Date; to?: Date }): Promise<string>;
  summaryForPeriod(context: RequestContext, from: Date): Promise<SalesSummary>;
  list(
    context: RequestContext,
    range?: { from?: Date; to?: Date; limit?: number },
  ): ReturnType<SalesRepository["list"]>;
}

export class DefaultSalesService implements SalesService {
  constructor(private readonly repository: SalesRepository) {}

  async create(context: RequestContext, input: SaleDraft) {
    assertTenantMutationAuthorized(context);
    if (!input.items.length) throw new Error("SALE_REQUIRES_ITEM");
    if (input.items.length > 100) throw new Error("SALE_TOO_MANY_ITEMS");
    if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
      throw new Error("INVALID_SALE_DATE");
    }
    const channel = input.channel.trim();
    if (!channel || channel.length > 40) throw new Error("INVALID_SALE_CHANNEL");

    let gross = new Decimal(0);
    const items = input.items.map((item) => {
      let quantity: Decimal;
      let unitPrice: Decimal;
      try {
        quantity = new Decimal(toDecimalString(item.quantity, 6));
        unitPrice = new Decimal(toDecimalString(item.unitPrice, 4));
      } catch {
        throw new Error("INVALID_SALE_DECIMAL");
      }
      if (!quantity.isFinite() || quantity.lte(0)) throw new Error("INVALID_SALE_QUANTITY");
      if (!unitPrice.isFinite() || unitPrice.lt(0)) throw new Error("INVALID_SALE_PRICE");
      const totalAmount = new Decimal(toDecimalString(quantity.mul(unitPrice), 4));
      gross = gross.plus(totalAmount);
      return {
        productId: item.productId,
        quantity: toDecimalString(quantity, 6),
        unitPrice: toDecimalString(unitPrice, 4),
        totalAmount: toDecimalString(totalAmount, 4),
      };
    });

    const grossAmount = toDecimalString(gross, 4);
    const netAmount = toDecimalString(input.netAmount ?? grossAmount, 4);
    if (new Decimal(netAmount).lt(0)) throw new Error("INVALID_SALE_NET_AMOUNT");
    if (new Decimal(netAmount).gt(new Decimal(grossAmount))) {
      throw new Error("INVALID_SALE_NET_AMOUNT");
    }

    const write: SaleWrite = {
      occurredAt: input.occurredAt,
      channel,
      grossAmount,
      netAmount,
      items,
    };
    return this.repository.create(context, write);
  }

  revenue(context: RequestContext, range?: { from?: Date; to?: Date }) {
    return this.repository.revenue(context, range);
  }

  summaryForPeriod(context: RequestContext, from: Date): Promise<SalesSummary> {
    return this.repository.summaryForPeriod(context, from);
  }

  list(
    context: RequestContext,
    range?: { from?: Date; to?: Date; limit?: number },
  ): ReturnType<SalesRepository["list"]> {
    return this.repository.list(context, range ?? {});
  }
}

export const salesService: SalesService = new DefaultSalesService(salesRepository);
