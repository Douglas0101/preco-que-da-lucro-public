import { assertTenantMutationAuthorized, type RequestContext } from "@/lib/request-context";
import type {
  FeeWrite,
  IngredientWrite,
  MarketPrice,
  MarketPriceWrite,
  PackagingWrite,
  Product,
  ProductChildKind,
  ProductDetailRows,
  ProductIngredient,
  ProductPackaging,
  ProductQuery,
  ProductReadModelRows,
  ProductRepository,
  ProductWrite,
  PurchasePriceRows,
  SalesFee,
} from "@/server/contracts/product.contracts";
import { productRepository } from "@/server/repositories/product.repository";

/**
 * Fachada do agregado Product: as operações que o BFF de produtos consome,
 * todas delegando ao port (`./contracts`). O BFF fala apenas com este serviço —
 * importar o repositório a partir de `src/lib/*.functions.ts` quebra o build do
 * cliente sob `import-protection` (o host nega `src/server/**` no ambiente
 * client), então a borda do repositório mora atrás da camada de serviço, junto
 * do adapter Drizzle que é o único arquivo do agregado com driver. As decisões
 * de negócio/financeiras (projeção, mapeamento snake_case, `priceUpdatedAt`,
 * violação de FK) continuam nos consumidores; aqui ficam a autorização de
 * mutação e a delegação.
 */
export interface ProductService {
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
}

export class DefaultProductService implements ProductService {
  constructor(private readonly repository: ProductRepository) {}

  list(context: RequestContext, query?: ProductQuery): Promise<Product[]> {
    return this.repository.list(context, query);
  }

  findById(context: RequestContext, id: string): Promise<Product | null> {
    return this.repository.findById(context, id);
  }

  async save(context: RequestContext, input: ProductWrite): Promise<Product> {
    assertTenantMutationAuthorized(context);
    return this.repository.save(context, input);
  }

  async archive(context: RequestContext, id: string): Promise<void> {
    assertTenantMutationAuthorized(context);
    await this.repository.archive(context, id);
  }

  loadDetail(context: RequestContext, productId: string): Promise<ProductDetailRows | null> {
    return this.repository.loadDetail(context, productId);
  }

  loadReadModel(context: RequestContext): Promise<ProductReadModelRows> {
    return this.repository.loadReadModel(context);
  }

  loadPurchasePriceRows(context: RequestContext): Promise<PurchasePriceRows> {
    return this.repository.loadPurchasePriceRows(context);
  }

  async saveIngredient(
    context: RequestContext,
    input: IngredientWrite,
  ): Promise<ProductIngredient> {
    assertTenantMutationAuthorized(context);
    return this.repository.saveIngredient(context, input);
  }

  async savePackaging(context: RequestContext, input: PackagingWrite): Promise<ProductPackaging> {
    assertTenantMutationAuthorized(context);
    return this.repository.savePackaging(context, input);
  }

  async saveFee(context: RequestContext, input: FeeWrite): Promise<SalesFee> {
    assertTenantMutationAuthorized(context);
    return this.repository.saveFee(context, input);
  }

  async createMarketPrice(context: RequestContext, input: MarketPriceWrite): Promise<MarketPrice> {
    assertTenantMutationAuthorized(context);
    return this.repository.createMarketPrice(context, input);
  }

  async deleteChild(context: RequestContext, kind: ProductChildKind, id: string): Promise<void> {
    assertTenantMutationAuthorized(context);
    await this.repository.deleteChild(context, kind, id);
  }
}

export const productService: ProductService = new DefaultProductService(productRepository);
