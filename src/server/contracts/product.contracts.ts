/**
 * §9.2 do plano (PLANO:790-802) — contrato do agregado Product independente de
 * driver.
 *
 * Somente-tipo, no mesmo padrão de `event.contracts.ts`/`memory.contracts.ts`:
 * nenhum valor executável e nenhum import do schema/driver do banco. Os quatro
 * caminhos residuais do item `9.2` (read-model do BFF, escritas de filho do BFF,
 * detalhe financeiro e preço de compra) conversam com este port; o adapter
 * Drizzle mora em `src/server/repositories/product.repository.ts`.
 *
 * As formas de linha são declaradas aqui — e não derivadas do schema —
 * para que o consumidor não dependa do driver. Elas são estruturalmente
 * idênticas às colunas do schema: `src/server/services/product.service.ts` e os
 * scripts de banco seguem tipando os mesmos consumidores, então uma divergência
 * de forma quebra o `tsc`.
 */
import type { RequestContext } from "@/lib/request-context";

export type ProductStatus = "draft" | "incomplete" | "ready" | "active" | "archived";

/** Linha de `products` (schema M-02). */
export interface Product {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  status: ProductStatus;
  currentPrice: string | null;
  yieldQty: string | null;
  yieldUnit: string | null;
  taxRegime: string | null;
  taxRate: string | null;
  isDemo: boolean;
  notes: string | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Linha de `product_ingredients`. */
export interface ProductIngredient {
  id: string;
  productId: string;
  tenantId: string;
  userId: string;
  name: string;
  usedQty: string;
  usedUnit: string;
  packagePrice: string | null;
  packageQty: string | null;
  packageUnit: string | null;
  conversionFactor: string | null;
  priceUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Linha de `product_packaging`. */
export interface ProductPackaging {
  id: string;
  productId: string;
  tenantId: string;
  userId: string;
  name: string;
  packagePrice: string;
  unitsPerPackage: string;
  priceUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Linha de `sales_fees`. */
export interface SalesFee {
  id: string;
  productId: string;
  tenantId: string;
  userId: string;
  name: string;
  percentage: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Linha de `market_prices`. */
export interface MarketPrice {
  id: string;
  productId: string;
  tenantId: string;
  userId: string;
  minPrice: string | null;
  avgPrice: string | null;
  maxPrice: string | null;
  createdAt: Date;
}

/** Referência mínima de produto usada pela tela de preços de compra. */
export interface ProductRef {
  id: string;
  name: string;
}

export interface ProductQuery {
  includeArchived?: boolean;
}

export interface ProductWrite {
  id?: string;
  /** Versão esperada para CAS otimista; obrigatória quando `id` está presente. */
  version?: number;
  name: string;
  currentPrice: string | null;
  yieldQty: string | null;
  yieldUnit: string | null;
  taxRegime: string | null;
  taxRate: string | null;
}

/** Filhos do agregado que aceitam escrita pelo BFF. */
export type ProductChildKind = "ingredient" | "packaging" | "fee";

/** Escrita de ingrediente: `id` presente atualiza (CAS por id+tenant), ausente
 * insere. `priceUpdatedAt` é decidido pelo chamador porque é regra de negócio
 * (só há carimbo quando o preço veio no payload). */
export interface IngredientWrite {
  id?: string;
  productId: string;
  name: string;
  usedQty: string;
  usedUnit: string;
  packagePrice: string | null;
  packageQty: string | null;
  packageUnit: string | null;
  conversionFactor: string | null;
  priceUpdatedAt: Date | null;
}

export interface PackagingWrite {
  id?: string;
  productId: string;
  name: string;
  packagePrice: string;
  unitsPerPackage: string;
  priceUpdatedAt: Date;
}

export interface FeeWrite {
  id?: string;
  productId: string;
  name: string;
  percentage: string;
}

/** Inserção append-only de referência de mercado (sem update por design). */
export interface MarketPriceWrite {
  productId: string;
  minPrice: string | null;
  avgPrice: string | null;
  maxPrice: string | null;
}

/** Atualização da linha base de ingrediente feita pelo preço de compra (§9.2
 * ponto 3): o histórico é append no port de preço, a coluna do filho é aqui. */
export interface IngredientPriceUpdate {
  id: string;
  packagePrice: string;
  packageQty: string;
  packageUnit: string;
  priceUpdatedAt: Date;
}

export interface PackagingPriceUpdate {
  id: string;
  packagePrice: string;
  unitsPerPackage: string;
  priceUpdatedAt: Date;
}

export interface IngredientPriceRow {
  id: string;
  packagePrice: string | null;
  priceUpdatedAt: Date | null;
}

export interface PackagingPriceRow {
  id: string;
  packagePrice: string;
  priceUpdatedAt: Date | null;
}

/** Colunas dos filhos do detalhe, já agrupadas por produto. */
export interface ProductDetailRows {
  product: Product;
  ingredients: ProductIngredient[];
  packaging: ProductPackaging[];
  fees: SalesFee[];
  market: MarketPrice | null;
}

/** Linhas cruas do read model consolidado (produto + filhos de todos os
 * produtos ativos em 2 queries); o agrupamento/projeção financeira fica no
 * chamador. */
export interface ProductReadModelRows {
  products: Product[];
  ingredients: ProductIngredient[];
  packaging: ProductPackaging[];
  fees: SalesFee[];
  market: MarketPrice[];
}

/** Linhas da tela de preços de compra: produtos ativos + filhos ordenados por
 * nome. */
export interface PurchasePriceRows {
  products: ProductRef[];
  ingredients: ProductIngredient[];
  packaging: ProductPackaging[];
}

/** Fatia do port usada por quem só precisa escrever a linha base dos filhos
 * (serviço de preço de compra) — o port inteiro continua exigido pelo BFF. */
export type ProductChildPriceWriter = Pick<
  ProductRepository,
  "updateIngredientPrice" | "updatePackagingPrice"
>;

export interface ProductRepository {
  list(context: RequestContext, query?: ProductQuery): Promise<Product[]>;
  findById(context: RequestContext, id: string): Promise<Product | null>;
  save(context: RequestContext, input: ProductWrite): Promise<Product>;
  archive(context: RequestContext, id: string): Promise<void>;
  loadDetail(context: RequestContext, productId: string): Promise<ProductDetailRows | null>;
  loadReadModel(context: RequestContext): Promise<ProductReadModelRows>;
  loadPurchasePriceRows(context: RequestContext): Promise<PurchasePriceRows>;
  saveIngredient(context: RequestContext, input: IngredientWrite): Promise<ProductIngredient>;
  savePackaging(context: RequestContext, input: PackagingWrite): Promise<ProductPackaging>;
  saveFee(context: RequestContext, input: FeeWrite): Promise<SalesFee>;
  createMarketPrice(context: RequestContext, input: MarketPriceWrite): Promise<MarketPrice>;
  deleteChild(context: RequestContext, kind: ProductChildKind, id: string): Promise<void>;
  updateIngredientPrice(
    context: RequestContext,
    input: IngredientPriceUpdate,
  ): Promise<IngredientPriceRow>;
  updatePackagingPrice(
    context: RequestContext,
    input: PackagingPriceUpdate,
  ): Promise<PackagingPriceRow>;
}
