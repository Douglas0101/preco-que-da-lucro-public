import Decimal from "decimal.js";
import { toDecimalString } from "@/lib/financial-values";
import { assertTenantMutationAuthorized, type RequestContext } from "@/lib/request-context";
import type { ProductChildPriceWriter } from "@/server/contracts/product.contracts";
import { productRepository } from "@/server/repositories/product.repository";
import {
  purchasePriceRepository,
  type PurchasePriceHistoryWrite,
  type PurchasePriceKind,
  type PurchasePriceRepository,
} from "@/server/repositories/purchase-price.repository";

export interface PurchasePriceUpdate {
  kind: PurchasePriceKind;
  subjectId: string;
  price: string;
  quantity: string;
  unit: string;
}

export interface PurchasePriceUpdateResult {
  id: string;
  packagePrice: string;
  priceUpdatedAt: Date;
  historyId: string;
}

export interface PurchasePriceService {
  append(context: RequestContext, input: PurchasePriceHistoryWrite): Promise<{ id: string }>;
  update(context: RequestContext, input: PurchasePriceUpdate): Promise<PurchasePriceUpdateResult>;
}

function validateMetadata(input: Pick<PurchasePriceHistoryWrite, "quantity" | "unit">): string {
  let quantity: Decimal;
  try {
    quantity = new Decimal(input.quantity);
  } catch {
    throw new Error("INVALID_PRICE_QUANTITY");
  }
  if (!quantity.isFinite() || quantity.lte(0)) throw new Error("INVALID_PRICE_QUANTITY");
  const unit = input.unit.trim();
  if (!unit) throw new Error("INVALID_PRICE_UNIT");
  return unit;
}

function normalizedPriceInput(input: PurchasePriceHistoryWrite): PurchasePriceHistoryWrite {
  const unit = validateMetadata(input);
  const price = new Decimal(input.price);
  if (!price.isFinite() || price.lt(0)) throw new Error("INVALID_PRICE");
  return {
    ...input,
    price: toDecimalString(price, 4),
    quantity: toDecimalString(new Decimal(input.quantity), 6),
    unit,
  };
}

/**
 * O `update` escreve em dois ports (§9.2): o histórico de preço (com o advisory
 * lock que serializa o read-modify-write) e a **linha base do filho do produto**
 * — coluna de `product_ingredients`/`product_packaging`, cujo adapter é o
 * `ProductRepository`. Nenhum dos dois expõe o driver: o serviço não conhece o
 * dialeto SQL nem o schema.
 */
export class DefaultPurchasePriceService implements PurchasePriceService {
  constructor(
    private readonly repository: PurchasePriceRepository,
    private readonly productChildren: ProductChildPriceWriter = productRepository,
  ) {}

  async append(context: RequestContext, input: PurchasePriceHistoryWrite) {
    assertTenantMutationAuthorized(context);
    const row = await this.repository.append(context, normalizedPriceInput(input));
    return { id: row.id };
  }

  async update(context: RequestContext, input: PurchasePriceUpdate) {
    assertTenantMutationAuthorized(context);
    // Lock ordering: serializa o read-modify-write ANTES de tocar a linha base;
    // o append reentra no mesmo advisory lock na mesma transação.
    await this.repository.lock(context, { kind: input.kind, subjectId: input.subjectId });
    const normalized = normalizedPriceInput({
      ...input,
      validFrom: new Date(),
    });
    const now = normalized.validFrom;

    if (input.kind === "ingredient") {
      const row = await this.productChildren.updateIngredientPrice(context, {
        id: input.subjectId,
        packagePrice: normalized.price,
        packageQty: normalized.quantity,
        packageUnit: normalized.unit,
        priceUpdatedAt: now,
      });
      const history = await this.repository.append(context, {
        ...normalized,
        kind: "ingredient",
        subjectId: row.id,
      });
      return {
        id: row.id,
        packagePrice: row.packagePrice ?? normalized.price,
        priceUpdatedAt: row.priceUpdatedAt ?? now,
        historyId: history.id,
      };
    }

    if (normalized.unit !== "unidade") throw new Error("INVALID_PRICE_UNIT");
    const row = await this.productChildren.updatePackagingPrice(context, {
      id: input.subjectId,
      packagePrice: normalized.price,
      unitsPerPackage: normalized.quantity,
      priceUpdatedAt: now,
    });
    const history = await this.repository.append(context, {
      ...normalized,
      kind: "packaging",
      subjectId: row.id,
    });
    return {
      id: row.id,
      packagePrice: row.packagePrice,
      priceUpdatedAt: row.priceUpdatedAt ?? now,
      historyId: history.id,
    };
  }
}

export const purchasePriceService: PurchasePriceService = new DefaultPurchasePriceService(
  purchasePriceRepository,
);
