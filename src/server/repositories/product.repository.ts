import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import {
  marketPrices,
  productIngredients,
  productPackaging,
  products,
  salesFees,
} from "@/db/schema";
import { LIST_LIMITS } from "@/lib/list-limits";
import type { RequestContext } from "@/lib/request-context";
import type {
  FeeWrite,
  IngredientPriceRow,
  IngredientPriceUpdate,
  IngredientWrite,
  MarketPrice,
  MarketPriceWrite,
  PackagingPriceRow,
  PackagingPriceUpdate,
  PackagingWrite,
  Product,
  ProductChildKind,
  ProductDetailRows,
  ProductIngredient,
  ProductPackaging,
  ProductQuery,
  ProductReadModelRows,
  ProductRef,
  ProductRepository,
  ProductWrite,
  PurchasePriceRows,
  SalesFee,
} from "@/server/contracts/product.contracts";

/**
 * Adapter Drizzle do port do agregado Product (`./contracts`): catálogo, CAS
 * otimista, read models consolidados e escritas de filho. Nenhuma regra de
 * negócio/financeira mora aqui — só SQL, decodificação de linhas e derivação de
 * tenant/usuário a partir do `RequestContext`.
 */

type IngredientSelect = ProductIngredient;
type PackagingSelect = ProductPackaging;
type FeeSelect = SalesFee;
type MarketSelect = MarketPrice;
type ChildUnionKind = "ingredient" | "packaging" | "fee" | "market";

/** Shape of one row of the consolidated children UNION: every branch carries
 * the full aligned column list (siblings contribute NULLs) plus branch tags. */
interface ChildUnionRow extends IngredientSelect {
  branch: number;
  ord: number;
  kind: ChildUnionKind;
  unitsPerPackage: string | null;
  percentage: string | null;
  minPrice: string | null;
  avgPrice: string | null;
  maxPrice: string | null;
}

function rowsFromQueryResult(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * O UNION consolidado executa via `execute()` (sem decoders do Drizzle), então
 * os valores chegam crús do driver: com neon-serverless, timestamptz volta como
 * string; com node-postgres, como Date. Normaliza os timestamps para Date antes
 * de devolvê-los (os mappers chamam .toISOString()) — paridade entre drivers.
 */
const CHILD_TIMESTAMP_FIELDS = ["createdAt", "updatedAt", "priceUpdatedAt"] as const;

function normalizeChildRow<T>(row: T): T {
  const normalized = { ...(row as Record<string, unknown>) };
  for (const key of CHILD_TIMESTAMP_FIELDS) {
    const value = normalized[key];
    if (typeof value === "string") {
      const parsed = new Date(value);
      normalized[key] = Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
  return normalized as T;
}

function ingredientChildBranch(
  context: RequestContext,
  productIds: string[],
  ord: SQL,
  orderColumns: SQL[] = [],
) {
  // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
  // driver; o contrato (`RequestContext`) segue driver-agnostic.
  const tx = context.transaction as DatabaseTransaction;
  return tx
    .select({
      branch: sql`1`.as("branch"),
      ord: ord.as("ord"),
      kind: sql`'ingredient'`.as("kind"),
      id: sql`${productIngredients.id}`.as("id"),
      productId: sql`${productIngredients.productId}`.as("productId"),
      tenantId: sql`${productIngredients.tenantId}`.as("tenantId"),
      userId: sql`${productIngredients.userId}`.as("userId"),
      name: sql`${productIngredients.name}`.as("name"),
      usedQty: sql`${productIngredients.usedQty}`.as("usedQty"),
      usedUnit: sql`${productIngredients.usedUnit}`.as("usedUnit"),
      packagePrice: sql`${productIngredients.packagePrice}`.as("packagePrice"),
      packageQty: sql`${productIngredients.packageQty}`.as("packageQty"),
      packageUnit: sql`${productIngredients.packageUnit}`.as("packageUnit"),
      conversionFactor: sql`${productIngredients.conversionFactor}`.as("conversionFactor"),
      priceUpdatedAt: sql`${productIngredients.priceUpdatedAt}`.as("priceUpdatedAt"),
      unitsPerPackage: sql`null::numeric`.as("unitsPerPackage"),
      percentage: sql`null::numeric`.as("percentage"),
      minPrice: sql`null::numeric`.as("minPrice"),
      avgPrice: sql`null::numeric`.as("avgPrice"),
      maxPrice: sql`null::numeric`.as("maxPrice"),
      createdAt: sql`${productIngredients.createdAt}`.as("createdAt"),
      updatedAt: sql`${productIngredients.updatedAt}`.as("updatedAt"),
    })
    .from(productIngredients)
    .where(
      and(
        eq(productIngredients.tenantId, context.tenantId),
        inArray(productIngredients.productId, productIds),
      ),
    )
    .orderBy(...orderColumns)
    .limit(LIST_LIMITS.productChildren);
}

function packagingChildBranch(
  context: RequestContext,
  productIds: string[],
  ord: SQL,
  orderColumns: SQL[] = [],
) {
  const tx = context.transaction as DatabaseTransaction;
  return tx
    .select({
      branch: sql`2`.as("branch"),
      ord: ord.as("ord"),
      kind: sql`'packaging'`.as("kind"),
      id: sql`${productPackaging.id}`.as("id"),
      productId: sql`${productPackaging.productId}`.as("productId"),
      tenantId: sql`${productPackaging.tenantId}`.as("tenantId"),
      userId: sql`${productPackaging.userId}`.as("userId"),
      name: sql`${productPackaging.name}`.as("name"),
      usedQty: sql`null::numeric`.as("usedQty"),
      usedUnit: sql`null::text`.as("usedUnit"),
      packagePrice: sql`${productPackaging.packagePrice}`.as("packagePrice"),
      packageQty: sql`null::numeric`.as("packageQty"),
      packageUnit: sql`null::text`.as("packageUnit"),
      conversionFactor: sql`null::numeric`.as("conversionFactor"),
      priceUpdatedAt: sql`${productPackaging.priceUpdatedAt}`.as("priceUpdatedAt"),
      unitsPerPackage: sql`${productPackaging.unitsPerPackage}`.as("unitsPerPackage"),
      percentage: sql`null::numeric`.as("percentage"),
      minPrice: sql`null::numeric`.as("minPrice"),
      avgPrice: sql`null::numeric`.as("avgPrice"),
      maxPrice: sql`null::numeric`.as("maxPrice"),
      createdAt: sql`${productPackaging.createdAt}`.as("createdAt"),
      updatedAt: sql`${productPackaging.updatedAt}`.as("updatedAt"),
    })
    .from(productPackaging)
    .where(
      and(
        eq(productPackaging.tenantId, context.tenantId),
        inArray(productPackaging.productId, productIds),
      ),
    )
    .orderBy(...orderColumns)
    .limit(LIST_LIMITS.productChildren);
}

function feeChildBranch(context: RequestContext, productIds: string[]) {
  const tx = context.transaction as DatabaseTransaction;
  return tx
    .select({
      branch: sql`3`.as("branch"),
      ord: sql`row_number() over ()`.as("ord"),
      kind: sql`'fee'`.as("kind"),
      id: sql`${salesFees.id}`.as("id"),
      productId: sql`${salesFees.productId}`.as("productId"),
      tenantId: sql`${salesFees.tenantId}`.as("tenantId"),
      userId: sql`${salesFees.userId}`.as("userId"),
      name: sql`${salesFees.name}`.as("name"),
      usedQty: sql`null::numeric`.as("usedQty"),
      usedUnit: sql`null::text`.as("usedUnit"),
      packagePrice: sql`null::numeric`.as("packagePrice"),
      packageQty: sql`null::numeric`.as("packageQty"),
      packageUnit: sql`null::text`.as("packageUnit"),
      conversionFactor: sql`null::numeric`.as("conversionFactor"),
      priceUpdatedAt: sql`null::timestamptz`.as("priceUpdatedAt"),
      unitsPerPackage: sql`null::numeric`.as("unitsPerPackage"),
      percentage: sql`${salesFees.percentage}`.as("percentage"),
      minPrice: sql`null::numeric`.as("minPrice"),
      avgPrice: sql`null::numeric`.as("avgPrice"),
      maxPrice: sql`null::numeric`.as("maxPrice"),
      createdAt: sql`${salesFees.createdAt}`.as("createdAt"),
      updatedAt: sql`${salesFees.updatedAt}`.as("updatedAt"),
    })
    .from(salesFees)
    .where(and(eq(salesFees.tenantId, context.tenantId), inArray(salesFees.productId, productIds)))
    .limit(LIST_LIMITS.productChildren);
}

function marketChildBranch(context: RequestContext, productIds: string[]) {
  const tx = context.transaction as DatabaseTransaction;
  return tx
    .select({
      branch: sql`4`.as("branch"),
      ord: sql`row_number() over (order by ${marketPrices.createdAt} desc)`.as("ord"),
      kind: sql`'market'`.as("kind"),
      id: sql`${marketPrices.id}`.as("id"),
      productId: sql`${marketPrices.productId}`.as("productId"),
      tenantId: sql`${marketPrices.tenantId}`.as("tenantId"),
      userId: sql`${marketPrices.userId}`.as("userId"),
      name: sql`null::text`.as("name"),
      usedQty: sql`null::numeric`.as("usedQty"),
      usedUnit: sql`null::text`.as("usedUnit"),
      packagePrice: sql`null::numeric`.as("packagePrice"),
      packageQty: sql`null::numeric`.as("packageQty"),
      packageUnit: sql`null::text`.as("packageUnit"),
      conversionFactor: sql`null::numeric`.as("conversionFactor"),
      priceUpdatedAt: sql`null::timestamptz`.as("priceUpdatedAt"),
      unitsPerPackage: sql`null::numeric`.as("unitsPerPackage"),
      percentage: sql`null::numeric`.as("percentage"),
      minPrice: sql`${marketPrices.minPrice}`.as("minPrice"),
      avgPrice: sql`${marketPrices.avgPrice}`.as("avgPrice"),
      maxPrice: sql`${marketPrices.maxPrice}`.as("maxPrice"),
      createdAt: sql`${marketPrices.createdAt}`.as("createdAt"),
      updatedAt: sql`null::timestamptz`.as("updatedAt"),
    })
    .from(marketPrices)
    .where(
      and(eq(marketPrices.tenantId, context.tenantId), inArray(marketPrices.productId, productIds)),
    )
    .orderBy(desc(marketPrices.createdAt))
    .limit(LIST_LIMITS.productChildren);
}

async function loadChildRows(context: RequestContext, union: SQL) {
  const tx = context.transaction as DatabaseTransaction;
  const result = await tx.execute(union);
  // SAFETY: the consolidated UNION runs through raw `execute()`, which bypasses
  // Drizzle's decoders, so the driver hands back `Record<string, unknown>`. The
  // rows ARE the aligned `ChildUnionRow` shape because every UNION branch projects
  // the full column superset (siblings contribute typed NULLs such as
  // `sql`null::numeric`.as("unitsPerPackage")`), so no field is ever absent.
  const rows = rowsFromQueryResult(result) as unknown as ChildUnionRow[];
  const ingredients: IngredientSelect[] = [];
  const packaging: PackagingSelect[] = [];
  const fees: FeeSelect[] = [];
  const market: MarketSelect[] = [];
  for (const rawRow of rows) {
    const row = normalizeChildRow(rawRow);
    // SAFETY: `kind` is the branch tag emitted by each UNION branch, and the
    // aligned-superset projection above guarantees that a row tagged 'packaging'
    // carries exactly the `PackagingSelect` payload in those columns (same for
    // 'fee'/'market'). TypeScript cannot verify it here because `ChildUnionRow` is
    // a flat interface extending `IngredientSelect` whose `kind` is a runtime tag,
    // not a discriminated union linking `kind` to the sibling shapes; and
    // `normalizeChildRow` is shape-preserving (it only rewrites the three timestamp
    // fields string->Date), so it does not invalidate the narrowing. FRAGILE: if a
    // branch changes its projected columns without updating this mapping, these
    // casts would silently hide the mismatch - the aligned superset is the guard.
    if (row.kind === "ingredient") ingredients.push(row);
    else if (row.kind === "packaging") packaging.push(row as unknown as PackagingSelect);
    else if (row.kind === "fee") fees.push(row as unknown as FeeSelect);
    else if (row.kind === "market") market.push(row as unknown as MarketSelect);
  }
  return { ingredients, packaging, fees, market };
}

const childTables = {
  ingredient: productIngredients,
  packaging: productPackaging,
  fee: salesFees,
} as const;

export class DrizzleProductRepository implements ProductRepository {
  async list(context: RequestContext, query: ProductQuery = {}): Promise<Product[]> {
    const tx = context.transaction as DatabaseTransaction;
    const predicates = [eq(products.tenantId, context.tenantId)];
    if (!query.includeArchived) predicates.push(isNull(products.archivedAt));

    return tx
      .select()
      .from(products)
      .where(and(...predicates))
      .orderBy(desc(products.createdAt));
  }

  async findById(context: RequestContext, id: string): Promise<Product | null> {
    const tx = context.transaction as DatabaseTransaction;
    const rows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), eq(products.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async save(context: RequestContext, input: ProductWrite): Promise<Product> {
    const tx = context.transaction as DatabaseTransaction;
    const values = {
      name: input.name,
      currentPrice: input.currentPrice,
      yieldQty: input.yieldQty,
      yieldUnit: input.yieldUnit,
      taxRegime: input.taxRegime,
      taxRate: input.taxRate,
      updatedAt: new Date(),
    };

    if (!input.id) {
      const rows = await tx
        .insert(products)
        .values({
          tenantId: context.tenantId,
          userId: context.userId,
          ...values,
        })
        .returning();
      if (!rows[0]) throw new Error("DATABASE_ERROR");
      return rows[0];
    }

    if (input.version === undefined) throw new Error("VALIDATION_ERROR");
    const rows = await tx
      .update(products)
      .set({ ...values, version: sql`${products.version} + 1` })
      .where(
        and(
          eq(products.tenantId, context.tenantId),
          eq(products.id, input.id),
          eq(products.version, input.version),
        ),
      )
      .returning();
    if (rows[0]) return rows[0];

    const existing = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), eq(products.id, input.id)))
      .limit(1);
    throw new Error(existing[0] ? "CONFLICT" : "NOT_FOUND");
  }

  async archive(context: RequestContext, id: string): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    const rows = await tx
      .update(products)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(products.tenantId, context.tenantId), eq(products.id, id)))
      .returning({ id: products.id });
    if (!rows.length) throw new Error("NOT_FOUND");
  }

  async loadDetail(context: RequestContext, productId: string): Promise<ProductDetailRows | null> {
    const tx = context.transaction as DatabaseTransaction;
    const productRows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), eq(products.id, productId)))
      .limit(1);
    const product = productRows[0];
    if (!product) return null;

    const ingredientRows = await tx
      .select()
      .from(productIngredients)
      .where(
        and(
          eq(productIngredients.tenantId, context.tenantId),
          eq(productIngredients.productId, productId),
        ),
      )
      .orderBy(asc(productIngredients.createdAt));
    const packagingRows = await tx
      .select()
      .from(productPackaging)
      .where(
        and(
          eq(productPackaging.tenantId, context.tenantId),
          eq(productPackaging.productId, productId),
        ),
      )
      .orderBy(asc(productPackaging.createdAt));
    const feeRows = await tx
      .select()
      .from(salesFees)
      .where(and(eq(salesFees.tenantId, context.tenantId), eq(salesFees.productId, productId)))
      .orderBy(asc(salesFees.createdAt));
    const marketRows = await tx
      .select()
      .from(marketPrices)
      .where(
        and(eq(marketPrices.tenantId, context.tenantId), eq(marketPrices.productId, productId)),
      )
      .orderBy(desc(marketPrices.createdAt))
      .limit(1);

    return {
      product,
      ingredients: ingredientRows,
      packaging: packagingRows,
      fees: feeRows,
      market: marketRows[0] ?? null,
    };
  }

  async loadReadModel(context: RequestContext): Promise<ProductReadModelRows> {
    const tx = context.transaction as DatabaseTransaction;
    const productRows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), isNull(products.archivedAt)))
      .orderBy(desc(products.createdAt))
      .limit(LIST_LIMITS.products);
    const productIds = productRows.map((row) => row.id);
    if (!productIds.length) {
      return { products: [], ingredients: [], packaging: [], fees: [], market: [] };
    }
    const scanOrder = sql`row_number() over ()`;
    const children = await loadChildRows(
      context,
      sql`${ingredientChildBranch(context, productIds, scanOrder)}
      union all ${packagingChildBranch(context, productIds, scanOrder)}
      union all ${feeChildBranch(context, productIds)}
      union all ${marketChildBranch(context, productIds)}
      order by branch, ord`,
    );
    return { products: productRows, ...children };
  }

  async loadPurchasePriceRows(context: RequestContext): Promise<PurchasePriceRows> {
    const tx = context.transaction as DatabaseTransaction;
    const productRows: ProductRef[] = await tx
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), isNull(products.archivedAt)))
      .orderBy(desc(products.createdAt))
      .limit(LIST_LIMITS.products);
    const productIds = productRows.map((row) => row.id);
    if (!productIds.length) return { products: [], ingredients: [], packaging: [] };
    const { ingredients, packaging } = await loadChildRows(
      context,
      sql`${ingredientChildBranch(
        context,
        productIds,
        sql`row_number() over (order by ${productIngredients.name})`,
        [asc(productIngredients.name)],
      )}
        union all ${packagingChildBranch(
          context,
          productIds,
          sql`row_number() over (order by ${productPackaging.name})`,
          [asc(productPackaging.name)],
        )}
        order by branch, ord`,
    );
    return { products: productRows, ingredients, packaging };
  }

  async saveIngredient(
    context: RequestContext,
    input: IngredientWrite,
  ): Promise<ProductIngredient> {
    const tx = context.transaction as DatabaseTransaction;
    const values = {
      tenantId: context.tenantId,
      userId: context.userId,
      productId: input.productId,
      name: input.name,
      usedQty: input.usedQty,
      usedUnit: input.usedUnit,
      packagePrice: input.packagePrice,
      packageQty: input.packageQty,
      packageUnit: input.packageUnit,
      conversionFactor: input.conversionFactor,
      priceUpdatedAt: input.priceUpdatedAt,
      updatedAt: new Date(),
    };
    const rows = input.id
      ? await tx
          .update(productIngredients)
          .set(values)
          .where(
            and(
              eq(productIngredients.tenantId, context.tenantId),
              eq(productIngredients.id, input.id),
            ),
          )
          .returning()
      : await tx.insert(productIngredients).values(values).returning();
    if (!rows[0]) throw new Error("NOT_FOUND");
    return rows[0];
  }

  async savePackaging(context: RequestContext, input: PackagingWrite): Promise<ProductPackaging> {
    const tx = context.transaction as DatabaseTransaction;
    const values = {
      tenantId: context.tenantId,
      userId: context.userId,
      productId: input.productId,
      name: input.name,
      packagePrice: input.packagePrice,
      unitsPerPackage: input.unitsPerPackage,
      priceUpdatedAt: input.priceUpdatedAt,
      updatedAt: new Date(),
    };
    const rows = input.id
      ? await tx
          .update(productPackaging)
          .set(values)
          .where(
            and(eq(productPackaging.tenantId, context.tenantId), eq(productPackaging.id, input.id)),
          )
          .returning()
      : await tx.insert(productPackaging).values(values).returning();
    if (!rows[0]) throw new Error("NOT_FOUND");
    return rows[0];
  }

  async saveFee(context: RequestContext, input: FeeWrite): Promise<SalesFee> {
    const tx = context.transaction as DatabaseTransaction;
    const values = {
      tenantId: context.tenantId,
      userId: context.userId,
      productId: input.productId,
      name: input.name,
      percentage: input.percentage,
      updatedAt: new Date(),
    };
    const rows = input.id
      ? await tx
          .update(salesFees)
          .set(values)
          .where(and(eq(salesFees.tenantId, context.tenantId), eq(salesFees.id, input.id)))
          .returning()
      : await tx.insert(salesFees).values(values).returning();
    if (!rows[0]) throw new Error("NOT_FOUND");
    return rows[0];
  }

  async createMarketPrice(context: RequestContext, input: MarketPriceWrite): Promise<MarketPrice> {
    const tx = context.transaction as DatabaseTransaction;
    const [row] = await tx
      .insert(marketPrices)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        productId: input.productId,
        minPrice: input.minPrice,
        avgPrice: input.avgPrice,
        maxPrice: input.maxPrice,
      })
      .returning();
    if (!row) throw new Error("DATABASE_ERROR");
    return row;
  }

  async deleteChild(context: RequestContext, kind: ProductChildKind, id: string): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    const table = childTables[kind];
    const rows = await tx
      .delete(table)
      .where(and(eq(table.tenantId, context.tenantId), eq(table.id, id)))
      .returning({ id: table.id });
    if (!rows.length) throw new Error("NOT_FOUND");
  }

  async updateIngredientPrice(
    context: RequestContext,
    input: IngredientPriceUpdate,
  ): Promise<IngredientPriceRow> {
    const tx = context.transaction as DatabaseTransaction;
    const rows = await tx
      .update(productIngredients)
      .set({
        packagePrice: input.packagePrice,
        packageQty: input.packageQty,
        packageUnit: input.packageUnit,
        priceUpdatedAt: input.priceUpdatedAt,
        updatedAt: input.priceUpdatedAt,
      })
      .where(
        and(eq(productIngredients.tenantId, context.tenantId), eq(productIngredients.id, input.id)),
      )
      .returning({
        id: productIngredients.id,
        packagePrice: productIngredients.packagePrice,
        priceUpdatedAt: productIngredients.priceUpdatedAt,
      });
    const row = rows[0];
    if (!row) throw new Error("NOT_FOUND");
    return row;
  }

  async updatePackagingPrice(
    context: RequestContext,
    input: PackagingPriceUpdate,
  ): Promise<PackagingPriceRow> {
    const tx = context.transaction as DatabaseTransaction;
    const rows = await tx
      .update(productPackaging)
      .set({
        packagePrice: input.packagePrice,
        unitsPerPackage: input.unitsPerPackage,
        priceUpdatedAt: input.priceUpdatedAt,
        updatedAt: input.priceUpdatedAt,
      })
      .where(
        and(eq(productPackaging.tenantId, context.tenantId), eq(productPackaging.id, input.id)),
      )
      .returning({
        id: productPackaging.id,
        packagePrice: productPackaging.packagePrice,
        priceUpdatedAt: productPackaging.priceUpdatedAt,
      });
    const row = rows[0];
    if (!row) throw new Error("NOT_FOUND");
    return row;
  }
}

export const productRepository: ProductRepository = new DrizzleProductRepository();

/** Re-export do port para os consumidores que já o importavam deste caminho. */
export type {
  FeeWrite,
  IngredientWrite,
  MarketPriceWrite,
  PackagingWrite,
  Product,
  ProductChildKind,
  ProductQuery,
  ProductRepository,
  ProductWrite,
} from "@/server/contracts/product.contracts";
