import { createServerFn } from "@tanstack/react-start";
import Decimal from "decimal.js";
import { z } from "zod";
import { ApplicationError } from "@/lib/api-error";
import type { FeeRow, IngredientRow, PackagingRow } from "@/lib/finance";
import {
  nonNegativeDecimalStringSchema,
  percentFractionSchema,
  positiveDecimalStringSchema,
  quantityUnitSchema,
  toDecimalString,
} from "@/lib/financial-values";
import { optimisticVersionSchema } from "@/lib/optimistic-version";
import type { RequestContext } from "@/lib/request-context";
import { requireDatabaseAuth } from "@/middleware/request-context";
import type {
  MarketPrice,
  Product,
  ProductChildKind,
  ProductIngredient,
  ProductPackaging,
  ProductStatus,
  SalesFee,
} from "@/server/contracts/product.contracts";
import { productService } from "@/server/services/product.service";
import { calculateProductReadModel } from "@/server/services/product-read-model.service";
import { purchasePriceService } from "@/server/services/purchase-price.service";

const uuid = z.string().uuid();
const decimalNumber = (value: string | null) =>
  value == null ? null : new Decimal(value).toNumber();
const percentPoints = (value: string | null) =>
  value == null ? null : new Decimal(value).mul(100).toNumber();

/** Projeções snake_case devolvidas ao BFF de produtos (contrato das rotas). */
interface ProductView {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  status: ProductStatus;
  current_price: string | null;
  yield_qty: string | null;
  yield_unit: string | null;
  tax_regime: string | null;
  tax_rate: string | null;
  is_demo: boolean;
  notes: string | null;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IngredientView {
  id: string;
  product_id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  used_qty: string;
  used_unit: string;
  package_price: string | null;
  package_qty: string | null;
  package_unit: string | null;
  conversion_factor: string | null;
  price_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PackagingView {
  id: string;
  product_id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  package_price: string;
  units_per_package: string;
  price_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FeeView {
  id: string;
  product_id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  percentage: string;
  created_at: string;
  updated_at: string;
}

interface MarketView {
  id: string;
  product_id: string;
  tenant_id: string;
  user_id: string;
  min_price: string | null;
  avg_price: string | null;
  max_price: string | null;
  created_at: string;
}

function mapProduct(row: Product): ProductView {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    user_id: row.userId,
    name: row.name,
    status: row.status,
    current_price: row.currentPrice,
    yield_qty: row.yieldQty,
    yield_unit: row.yieldUnit,
    tax_regime: row.taxRegime,
    tax_rate: row.taxRate,
    is_demo: row.isDemo,
    notes: row.notes,
    version: row.version,
    archived_at: row.archivedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function mapIngredient(row: ProductIngredient): IngredientView {
  return {
    id: row.id,
    product_id: row.productId,
    tenant_id: row.tenantId,
    user_id: row.userId,
    name: row.name,
    used_qty: row.usedQty,
    used_unit: row.usedUnit,
    package_price: row.packagePrice,
    package_qty: row.packageQty,
    package_unit: row.packageUnit,
    conversion_factor: row.conversionFactor,
    price_updated_at: row.priceUpdatedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function mapPackaging(row: ProductPackaging): PackagingView {
  return {
    id: row.id,
    product_id: row.productId,
    tenant_id: row.tenantId,
    user_id: row.userId,
    name: row.name,
    package_price: row.packagePrice,
    units_per_package: row.unitsPerPackage,
    price_updated_at: row.priceUpdatedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function mapFee(row: SalesFee): FeeView {
  return {
    id: row.id,
    product_id: row.productId,
    tenant_id: row.tenantId,
    user_id: row.userId,
    name: row.name,
    percentage: row.percentage,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function mapMarket(row: MarketPrice): MarketView {
  return {
    id: row.id,
    product_id: row.productId,
    tenant_id: row.tenantId,
    user_id: row.userId,
    min_price: row.minPrice,
    avg_price: row.avgPrice,
    max_price: row.maxPrice,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * FKs de `purchase_price_history` que restringem (`ON DELETE restrict`) o delete
 * dos filhos do produto. Os nomes estão **truncados em 63 bytes**: o literal da
 * migration `0004_giant_nocturne.sql` tem 79/82 caracteres e o PostgreSQL corta
 * identificadores em `NAMEDATALEN - 1`, então é o nome cortado que chega em
 * `DatabaseError.constraint` (medido no PG17 efêmero).
 */
const PURCHASE_HISTORY_FKS: Readonly<Record<string, true>> = {
  purchase_price_history_tenant_id_ingredient_id_product_ingredie: true,
  purchase_price_history_tenant_id_packaging_id_product_packaging: true,
};

/** Elos da cadeia de causas inspecionados. O `DatabaseError` do driver fica em
 * `depth = 1` (medido); a folga cobre wrappers futuros e uma cadeia circular ou
 * mais funda que o limite devolve `null` sem travar. */
const FK_CAUSE_CHAIN_LIMIT = 4;

/** Violação de chave estrangeira do Postgres (SQLSTATE `23503`). O Drizzle
 * embrulha o erro do driver (`DrizzleQueryError`), então o SQLSTATE tem de ser
 * buscado na cadeia de causas — mesma técnica de `isUniqueViolation` em
 * `src/server/repositories/memory.repository.ts`. Devolve a `constraint`
 * (quando o driver a informa) para quem chama distinguir **qual** FK caiu:
 * um `23503` de outra tabela não tem nada a ver com histórico de preços. */
function foreignKeyViolation(error: unknown): { constraint: string | null } | null {
  let current: unknown = error;
  for (let depth = 0; depth < FK_CAUSE_CHAIN_LIMIT; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && current.code === "23503") {
      const { constraint } = current as { constraint?: unknown };
      return { constraint: typeof constraint === "string" ? constraint : null };
    }
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

function toFinanceIngredient(item: IngredientView): IngredientRow {
  return {
    used_qty: decimalNumber(item.used_qty) as number,
    used_unit: item.used_unit,
    package_price: decimalNumber(item.package_price),
    package_qty: decimalNumber(item.package_qty),
    package_unit: item.package_unit,
    conversion_context:
      item.conversion_factor != null && item.package_unit != null
        ? {
            fromUnit: item.used_unit,
            toUnit: item.package_unit,
            factor: item.conversion_factor,
            contextId: item.id,
          }
        : undefined,
  };
}

function toFinancePackaging(item: PackagingView): PackagingRow {
  return {
    package_price: decimalNumber(item.package_price) as number,
    units_per_package: decimalNumber(item.units_per_package) as number,
  };
}

function toFinanceFee(item: FeeView): FeeRow {
  return { percentage: percentPoints(item.percentage) };
}

function projectProductCalculation(
  product: ProductView,
  ingredients: IngredientView[],
  packaging: PackagingView[],
  fees: FeeView[],
) {
  const calculation = calculateProductReadModel({
    persistedStatus: product.status,
    currentPrice: product.current_price,
    yieldQty: product.yield_qty,
    taxRate: product.tax_rate,
    ingredients: ingredients.map(toFinanceIngredient),
    packaging: packaging.map(toFinancePackaging),
    fees: fees.map(toFinanceFee),
  });
  return calculation;
}

async function loadProductDetail(request: RequestContext, productId: string) {
  const detail = await productService.loadDetail(request, productId);
  if (!detail) throw new Error("NOT_FOUND");

  const product = mapProduct(detail.product);
  const ingredients = detail.ingredients.map(mapIngredient);
  const packaging = detail.packaging.map(mapPackaging);
  const fees = detail.fees.map(mapFee);
  const market = detail.market ? mapMarket(detail.market) : null;
  const calculation = projectProductCalculation(product, ingredients, packaging, fees);
  return {
    product: { ...product, status: calculation.status },
    ingredients,
    packaging,
    fees,
    market,
    metrics: calculation.metrics,
    completeness: calculation.completeness,
  };
}

async function loadProductReadModels(request: RequestContext) {
  const rows = await productService.loadReadModel(request);
  const productRows = rows.products;
  if (!productRows.length) return [];
  const ingredientsByProduct = new Map<string, IngredientView[]>();
  for (const item of rows.ingredients) {
    const rows = ingredientsByProduct.get(item.productId) ?? [];
    rows.push(mapIngredient(item));
    ingredientsByProduct.set(item.productId, rows);
  }
  const packagingByProduct = new Map<string, PackagingView[]>();
  for (const item of rows.packaging) {
    const rows = packagingByProduct.get(item.productId) ?? [];
    rows.push(mapPackaging(item));
    packagingByProduct.set(item.productId, rows);
  }
  const feesByProduct = new Map<string, FeeView[]>();
  for (const item of rows.fees) {
    const rows = feesByProduct.get(item.productId) ?? [];
    rows.push(mapFee(item));
    feesByProduct.set(item.productId, rows);
  }
  const marketByProduct = new Map<string, MarketView>();
  for (const item of rows.market) {
    if (!marketByProduct.has(item.productId)) marketByProduct.set(item.productId, mapMarket(item));
  }

  return productRows.map((row) => {
    const product = mapProduct(row);
    const ingredients = ingredientsByProduct.get(row.id) ?? [];
    const packaging = packagingByProduct.get(row.id) ?? [];
    const fees = feesByProduct.get(row.id) ?? [];
    const calculation = projectProductCalculation(product, ingredients, packaging, fees);
    return {
      product: { ...product, status: calculation.status },
      ingredients,
      packaging,
      fees,
      market: marketByProduct.get(row.id) ?? null,
      metrics: calculation.metrics,
      completeness: calculation.completeness,
    };
  });
}

export const listProducts = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const request = context.requestContext;
    const rows = await loadProductReadModels(request);
    return rows.map(({ product }) => product);
  });

export const listProductsWithMetrics = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    return loadProductReadModels(context.requestContext);
  });

export const getProduct = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const detail = await loadProductDetail(context.requestContext, data.id);
    return {
      product: detail.product,
      ingredients: detail.ingredients,
      packaging: detail.packaging,
      fees: detail.fees,
      market: detail.market,
    };
  });

const productFields = z.object({
  name: z.string().trim().min(1).max(160),
  current_price: nonNegativeDecimalStringSchema.nullable().optional(),
  yield_qty: positiveDecimalStringSchema.nullable().optional(),
  yield_unit: quantityUnitSchema.nullable().optional(),
  tax_regime: z.string().trim().max(80).nullable().optional(),
  tax_rate: percentFractionSchema.nullable().optional(),
});

/** Contrato de criação: sem `id`/`version` (o banco inicia em 0). */
export const createProductInput = productFields;

/** Contrato de atualização: CAS otimista exige `id` + `version` correntes. */
export const updateProductInput = productFields.extend({
  id: uuid,
  version: optimisticVersionSchema,
});

/**
 * Compatibilidade: o input legado aceita `id` opcional, mas atualização sem
 * `version` falha em VALIDATION_ERROR — nunca faz last-write-wins.
 */
const legacyProductInput = productFields
  .extend({
    id: uuid.optional(),
    version: optimisticVersionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.id && value.version === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "Atualização exige a versão corrente do produto.",
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

type ProductFields = z.output<typeof productFields>;

function toProductWrite(data: ProductFields) {
  return {
    name: data.name,
    currentPrice: data.current_price == null ? null : toDecimalString(data.current_price, 4),
    yieldQty: data.yield_qty == null ? null : toDecimalString(data.yield_qty, 6),
    yieldUnit: data.yield_unit ?? null,
    taxRegime: data.tax_regime ?? null,
    taxRate: data.tax_rate == null ? null : toDecimalString(data.tax_rate, 6),
  };
}

async function createProductWrite(
  request: RequestContext,
  data: ProductFields,
): Promise<ProductView> {
  const product = await productService.save(request, toProductWrite(data));
  return mapProduct(product);
}

async function updateProductWrite(
  request: RequestContext,
  data: z.output<typeof updateProductInput>,
): Promise<ProductView> {
  const product = await productService.save(request, {
    id: data.id,
    version: data.version,
    ...toProductWrite(data),
  });
  return mapProduct(product);
}

export const createProduct = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => createProductInput.parse(input))
  .handler(async ({ data, context }) => createProductWrite(context.requestContext, data));

export const updateProduct = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => updateProductInput.parse(input))
  .handler(async ({ data, context }) => updateProductWrite(context.requestContext, data));

/** Dispatcher legado: sem `id` cria; com `id` + `version` atualiza via CAS. */
export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => legacyProductInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    if (!data.id) return createProductWrite(request, data);
    return updateProductWrite(request, updateProductInput.parse(data));
  });

export const archiveProduct = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    await productService.archive(request, data.id);
    return { ok: true };
  });

// Compatibility alias for existing consumers; deletion becomes recoverable archive.
export const deleteProduct = archiveProduct;

const ingredientInput = z
  .object({
    id: uuid.optional(),
    product_id: uuid,
    name: z.string().trim().min(1).max(160),
    used_qty: positiveDecimalStringSchema,
    used_unit: quantityUnitSchema,
    package_price: nonNegativeDecimalStringSchema.nullable().optional(),
    package_qty: positiveDecimalStringSchema.nullable().optional(),
    package_unit: quantityUnitSchema.nullable().optional(),
    conversion_factor: positiveDecimalStringSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const hasQuantity = value.package_qty != null;
    const hasUnit = value.package_unit != null;
    if (hasQuantity !== hasUnit) {
      ctx.addIssue({
        code: "custom",
        path: [hasQuantity ? "package_unit" : "package_qty"],
        message: "Informe quantidade e unidade da embalagem juntas.",
      });
    }
    if (value.package_price != null && (!hasQuantity || !hasUnit)) {
      ctx.addIssue({
        code: "custom",
        path: ["package_price"],
        message: "O histórico exige quantidade e unidade para registrar o preço.",
      });
    }
  });

export const upsertIngredient = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => ingredientInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    const priceUpdatedAt = data.package_price == null ? null : new Date();
    const row = await productService.saveIngredient(request, {
      id: data.id,
      productId: data.product_id,
      name: data.name,
      usedQty: toDecimalString(data.used_qty, 6),
      usedUnit: data.used_unit,
      packagePrice: data.package_price == null ? null : toDecimalString(data.package_price, 4),
      packageQty: data.package_qty == null ? null : toDecimalString(data.package_qty, 6),
      packageUnit: data.package_unit ?? null,
      conversionFactor:
        data.conversion_factor == null ? null : toDecimalString(data.conversion_factor, 8),
      priceUpdatedAt,
    });
    if (data.package_price != null && data.package_qty != null && data.package_unit != null) {
      await purchasePriceService.append(request, {
        kind: "ingredient",
        subjectId: row.id,
        price: data.package_price,
        quantity: data.package_qty,
        unit: data.package_unit,
        validFrom: priceUpdatedAt ?? new Date(),
      });
    }
    return mapIngredient(row);
  });

/**
 * Corpo compartilhado dos deletes de filho. É um helper de módulo — e não uma
 * fábrica de `createServerFn` — porque o compilador do TanStack exige que cada
 * `createServerFn` seja atribuído a uma variável no topo do módulo: uma cadeia
 * aninhada não é extraída para o módulo servidor, o que deixa o handler e o
 * import do serviço vivos no bundle do cliente (`import-protection`).
 */
async function deleteProductChild(
  request: RequestContext,
  kind: ProductChildKind,
  id: string,
): Promise<{ ok: true }> {
  try {
    await productService.deleteChild(request, kind, id);
  } catch (error) {
    const violation = foreignKeyViolation(error);
    if (!violation) throw error;
    const history =
      violation.constraint !== null && PURCHASE_HISTORY_FKS[violation.constraint] === true;
    throw new ApplicationError("CONFLICT", {
      cause: error,
      message: history
        ? "O registro possui histórico de preços e não pode ser removido."
        : "O registro está referenciado por outros registros e não pode ser removido.",
    });
  }
  return { ok: true };
}

export const deleteIngredient = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) =>
    deleteProductChild(context.requestContext, "ingredient", data.id),
  );

const packagingInput = z.object({
  id: uuid.optional(),
  product_id: uuid,
  name: z.string().trim().min(1).max(160),
  package_price: nonNegativeDecimalStringSchema,
  units_per_package: positiveDecimalStringSchema,
});

export const upsertPackaging = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => packagingInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    const priceUpdatedAt = new Date();
    const row = await productService.savePackaging(request, {
      id: data.id,
      productId: data.product_id,
      name: data.name,
      packagePrice: toDecimalString(data.package_price, 4),
      unitsPerPackage: toDecimalString(data.units_per_package, 6),
      priceUpdatedAt,
    });
    await purchasePriceService.append(request, {
      kind: "packaging",
      subjectId: row.id,
      price: data.package_price,
      quantity: data.units_per_package,
      unit: "unidade",
      validFrom: priceUpdatedAt,
    });
    return mapPackaging(row);
  });

export const deletePackaging = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) =>
    deleteProductChild(context.requestContext, "packaging", data.id),
  );

const feeInput = z.object({
  id: uuid.optional(),
  product_id: uuid,
  name: z.string().trim().min(1).max(160),
  percentage: percentFractionSchema,
});

export const upsertFee = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => feeInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    const row = await productService.saveFee(request, {
      id: data.id,
      productId: data.product_id,
      name: data.name,
      percentage: toDecimalString(data.percentage, 6),
    });
    return mapFee(row);
  });

export const deleteFee = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => deleteProductChild(context.requestContext, "fee", data.id));

const marketInput = z.object({
  product_id: uuid,
  min_price: nonNegativeDecimalStringSchema.nullable().optional(),
  avg_price: nonNegativeDecimalStringSchema.nullable().optional(),
  max_price: nonNegativeDecimalStringSchema.nullable().optional(),
});

export const setMarketPrice = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => marketInput.parse(input))
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    const row = await productService.createMarketPrice(request, {
      productId: data.product_id,
      minPrice: data.min_price == null ? null : toDecimalString(data.min_price, 4),
      avgPrice: data.avg_price == null ? null : toDecimalString(data.avg_price, 4),
      maxPrice: data.max_price == null ? null : toDecimalString(data.max_price, 4),
    });
    return mapMarket(row);
  });

export const getProductMetrics = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const detail = await loadProductDetail(context.requestContext, data.id);
    return {
      product: detail.product,
      metrics: detail.metrics,
      completeness: detail.completeness,
    };
  });

export const listPurchasePrices = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const rows = await productService.loadPurchasePriceRows(context.requestContext);
    return {
      products: rows.products,
      ingredients: rows.ingredients.map(mapIngredient),
      packaging: rows.packaging.map(mapPackaging),
    };
  });

export const updatePurchasePrice = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: uuid,
        kind: z.enum(["ingrediente", "embalagem"]),
        package_price: nonNegativeDecimalStringSchema,
        package_qty: positiveDecimalStringSchema,
        package_unit: quantityUnitSchema,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const request = context.requestContext;
    const updated = await purchasePriceService.update(request, {
      kind: data.kind === "ingrediente" ? "ingredient" : "packaging",
      subjectId: data.id,
      price: data.package_price,
      quantity: data.package_qty,
      unit: data.package_unit,
    });
    return {
      id: updated.id,
      package_price: updated.packagePrice,
      price_updated_at: updated.priceUpdatedAt.toISOString(),
      history_id: updated.historyId,
    };
  });
