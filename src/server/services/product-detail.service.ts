import Decimal from "decimal.js";
import type {
  CalculationResult,
  FeeRow,
  IngredientRow,
  PackagingRow,
  ProductComputation,
} from "@/lib/finance";
import type { RequestContext } from "@/lib/request-context";
import { productRepository } from "@/server/repositories/product.repository";
import { calculateProductReadModel } from "@/server/services/product-read-model.service";

const decimalNumber = (value: string | null): number | null =>
  value == null ? null : new Decimal(value).toNumber();
const percentPoints = (value: string | null): number | null =>
  value == null ? null : new Decimal(value).mul(100).toNumber();

export interface ProductFinancialDetail {
  product: {
    id: string;
    name: string;
    status: "draft" | "incomplete" | "ready" | "active" | "archived";
    currentPrice: string | null;
    yieldQty: string | null;
    taxRate: string | null;
  };
  ingredients: IngredientRow[];
  packaging: PackagingRow[];
  fees: FeeRow[];
  market: { avgPrice: string | null } | null;
  metrics: CalculationResult<ProductComputation>;
}

/**
 * Loads one tenant-scoped product with its children and projects the
 * financial read model, on the current request transaction (RLS applies).
 * This is the server-side detail source for the diagnostic BFF. As leituras
 * passam pelo port do agregado (§9.2) — nenhum SQL/driver aqui.
 */
export async function loadProductFinancialDetail(
  context: RequestContext,
  productId: string,
): Promise<ProductFinancialDetail | null> {
  const detail = await productRepository.loadDetail(context, productId);
  if (!detail) return null;
  const { product } = detail;

  const ingredients: IngredientRow[] = detail.ingredients.map((row) => ({
    used_qty: decimalNumber(row.usedQty) as number,
    used_unit: row.usedUnit,
    package_price: decimalNumber(row.packagePrice),
    package_qty: decimalNumber(row.packageQty),
    package_unit: row.packageUnit,
    conversion_context:
      row.conversionFactor != null && row.packageUnit != null
        ? {
            fromUnit: row.usedUnit,
            toUnit: row.packageUnit,
            factor: row.conversionFactor,
            contextId: row.id,
          }
        : undefined,
  }));
  const packaging: PackagingRow[] = detail.packaging.map((row) => ({
    package_price: decimalNumber(row.packagePrice) as number,
    units_per_package: decimalNumber(row.unitsPerPackage) as number,
  }));
  const fees: FeeRow[] = detail.fees.map((row) => ({ percentage: percentPoints(row.percentage) }));

  const calculation = calculateProductReadModel({
    persistedStatus: product.status,
    currentPrice: product.currentPrice,
    yieldQty: product.yieldQty,
    taxRate: product.taxRate,
    ingredients,
    packaging,
    fees,
  });

  return {
    product: {
      id: product.id,
      name: product.name,
      status: product.status,
      currentPrice: product.currentPrice,
      yieldQty: product.yieldQty,
      taxRate: product.taxRate,
    },
    ingredients,
    packaging,
    fees,
    market: detail.market ? { avgPrice: detail.market.avgPrice } : null,
    metrics: calculation.metrics,
  };
}
