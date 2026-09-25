import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { DatabaseTransaction } from "@/db/client.server";
import type { RequestContext } from "@/lib/request-context";
import { productRepository } from "@/server/repositories/product.repository";
import { ensureRuntimeRoleMembership, runMigrations } from "../../scripts/db/migrate";
import { dbPrecondition, skipLabel } from "./helpers/db-precondition";

const CONTRACT_PATH = "src/server/contracts/product.contracts.ts";

/** Os três módulos consumidores do port que precisam ficar sem driver (§9.2). */
const PORT_CONSUMERS = [
  "src/lib/products.functions.ts",
  "src/server/services/purchase-price.service.ts",
  "src/server/services/product-detail.service.ts",
] as const;

/** Import proibido em contrato: o port não pode depender do driver nem do schema. */
const FORBIDDEN_MODULES = ["@/db", "drizzle-orm", "src/server/repositories"];

function projectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function parseContract(path: string): ts.SourceFile {
  return ts.createSourceFile(path, projectFile(path), ts.ScriptTarget.Latest, true);
}

function importedModules(source: ts.SourceFile): string[] {
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
}

function exportedTypeNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function isTypeOnly(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly === true;
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

function methodNames(source: ts.SourceFile, interfaceName: string): string[] {
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
  if (!declaration) return [];
  return declaration.members
    .filter(ts.isMethodSignature)
    .map((member) => member.name.getText(source));
}

describe("contrato do agregado Product (§9.2 — independente de driver)", () => {
  it("declara as operações que os 4 pontos residuais exigem", () => {
    const methods = methodNames(parseContract(CONTRACT_PATH), "ProductRepository");
    expect(methods).toEqual(
      expect.arrayContaining([
        "list",
        "findById",
        "save",
        "archive",
        "loadDetail",
        "loadReadModel",
        "loadPurchasePriceRows",
        "saveIngredient",
        "savePackaging",
        "saveFee",
        "createMarketPrice",
        "deleteChild",
        "updateIngredientPrice",
        "updatePackagingPrice",
      ]),
    );
  });

  it("exporta as formas de linha que os consumidores usam sem importar o schema", () => {
    const names = exportedTypeNames(parseContract(CONTRACT_PATH));
    expect(names).toEqual(
      expect.arrayContaining([
        "Product",
        "ProductQuery",
        "ProductWrite",
        "ProductRepository",
        "ProductDetailRows",
        "ProductReadModelRows",
        "PurchasePriceRows",
        "ProductChildKind",
        "ProductChildPriceWriter",
      ]),
    );
  });

  it("não importa @/db, drizzle-orm nem repositórios", () => {
    const modules = importedModules(parseContract(CONTRACT_PATH));
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(modules.some((module) => module.startsWith(forbidden))).toBe(false);
    }
    expect(modules.length).toBeGreaterThan(0);
  });

  it("é type-only (nenhum valor executável)", () => {
    const source = parseContract(CONTRACT_PATH);
    expect(source.statements.length).toBeGreaterThan(0);
    expect(source.statements.filter((statement) => !isTypeOnly(statement))).toEqual([]);
  });

  it("mantém os 3 consumidores sem driver na transação (§9.2 aceitação 1)", () => {
    for (const path of PORT_CONSUMERS) {
      const source = projectFile(path);
      expect(source).not.toContain("drizzle-orm");
      expect(source).not.toContain("@/db/schema");
      expect(source).not.toContain(".transaction");
    }
  });
});

/**
 * Prova em banco descartável (PG local efêmero) das operações que o port ganhou
 * no §9.2. A sessão roda **como `app_runtime`** (NOSUPERUSER/NOBYPASSRLS): o
 * admin do container é superuser e bypassaria RLS, então cada caso abre uma
 * transação com `set local role app_runtime` + GUCs do tenant — mesma técnica de
 * `scripts/db/test-migrations.ts` e `scripts/db/test-outbox.ts`.
 *
 * Gate fail-closed: qualquer URL que não seja loopback (ou a credencial de
 * produção herdada `DATABASE_URL_UNPOOLED`) desabilita o bloco — nada aqui toca
 * host remoto/Neon.
 */
const TENANT_A = "a1000000-0000-4000-8000-000000000001";
const USER_A = "a1000000-0000-4000-8000-000000000002";
const PRODUCT_A = "a1000000-0000-4000-8000-000000000003";
const INGREDIENT_A = "a1000000-0000-4000-8000-000000000004";
const PACKAGING_A = "a1000000-0000-4000-8000-000000000005";
const FEE_A = "a1000000-0000-4000-8000-000000000006";
const MARKET_A = "a1000000-0000-4000-8000-000000000007";
const TENANT_B = "b2000000-0000-4000-8000-000000000001";
const USER_B = "b2000000-0000-4000-8000-000000000002";
const PRODUCT_B = "b2000000-0000-4000-8000-000000000003";
const INGREDIENT_B = "b2000000-0000-4000-8000-000000000004";
const PACKAGING_B = "b2000000-0000-4000-8000-000000000005";
const FEE_B = "b2000000-0000-4000-8000-000000000006";

const NEW_INGREDIENT_NAME = "Açúcar mascavo";

/** Linhas de um resultado de `execute()` do driver; fail-closed se não houver `rows`. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return result.rows;
  }
  throw new Error("resultado do driver sem linhas");
}

const adminUrl = process.env.DATABASE_ADMIN_URL;
const dbGate = dbPrecondition();
if (!dbGate.enabled) console.log(skipLabel(dbGate.motivo));
const dbDescribe = dbGate.enabled ? describe : describe.skip;

async function seedTenant(
  pool: Pool,
  tenantId: string,
  userId: string,
  slug: string,
): Promise<void> {
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, $2, $3, true)
     on conflict (id) do update set name = excluded.name`,
    [userId, `Usuário ${slug}`, `${slug}@product-contracts.test`],
  );
  await pool.query(
    `insert into tenants (id, name, slug) values ($1, $2, $3)
     on conflict (id) do update set name = excluded.name`,
    [tenantId, `Tenant ${slug}`, slug],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'owner')
     on conflict (tenant_id, user_id) do update set role = 'owner'`,
    [tenantId, userId],
  );
}

dbDescribe("ProductRepository — operações do port sob app_runtime (PG efêmero)", () => {
  const pool = new Pool({ connectionString: adminUrl ?? "", max: 2 });
  const database = drizzle({ client: pool, schema });

  function contextFor(
    transaction: RequestContext["transaction"],
    tenantId: string,
    userId: string,
  ): RequestContext {
    return {
      userId,
      tenantId,
      roles: ["owner"],
      correlationId: "c3000000-0000-4000-8000-000000000001",
      signal: AbortSignal.timeout(15_000),
      transaction,
    };
  }

  /** Executa `operation` numa transação como `app_runtime` com os GUCs do tenant. */
  function asTenant<T>(
    tenantId: string,
    userId: string,
    operation: (context: RequestContext) => Promise<T>,
  ): Promise<T> {
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(sql`
        select
          set_config('app.current_user_id', ${userId}, true),
          set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_roles', 'owner', true)
      `);
      return operation(
        contextFor(transaction as unknown as RequestContext["transaction"], tenantId, userId),
      );
    });
  }

  beforeAll(async () => {
    await runMigrations(adminUrl);
    await ensureRuntimeRoleMembership(pool);
    for (const [tenantId, userId, slug] of [
      [TENANT_A, USER_A, "product-contracts-a"],
      [TENANT_B, USER_B, "product-contracts-b"],
    ] as const) {
      await pool.query("delete from product_ingredients where tenant_id = $1", [tenantId]);
      await pool.query("delete from product_packaging where tenant_id = $1", [tenantId]);
      await pool.query("delete from sales_fees where tenant_id = $1", [tenantId]);
      await pool.query("delete from market_prices where tenant_id = $1", [tenantId]);
      await pool.query("delete from products where tenant_id = $1", [tenantId]);
      await seedTenant(pool, tenantId, userId, slug);
    }
    for (const [tenantId, userId, productId, ingredientId, packagingId, feeId, marketId] of [
      [TENANT_A, USER_A, PRODUCT_A, INGREDIENT_A, PACKAGING_A, FEE_A, MARKET_A],
      [TENANT_B, USER_B, PRODUCT_B, INGREDIENT_B, PACKAGING_B, FEE_B, null],
    ] as const) {
      await pool.query(
        `insert into products (id, tenant_id, user_id, name, current_price, yield_qty, yield_unit, status, version)
         values ($1, $2, $3, $4, '25.0000', '12.000000', 'unidade', 'active', 0)`,
        [productId, tenantId, userId, `Produto ${tenantId.slice(0, 6)}`],
      );
      await pool.query(
        `insert into product_ingredients
           (id, product_id, tenant_id, user_id, name, used_qty, used_unit, package_price, package_qty, package_unit)
         values ($1, $2, $3, $4, 'Farinha', '1.000000', 'kg', '8.9000', '5.000000', 'kg')`,
        [ingredientId, productId, tenantId, userId],
      );
      await pool.query(
        `insert into product_packaging
           (id, product_id, tenant_id, user_id, name, package_price, units_per_package)
         values ($1, $2, $3, $4, 'Caixa', '1.2000', '10.000000')`,
        [packagingId, productId, tenantId, userId],
      );
      await pool.query(
        `insert into sales_fees (id, product_id, tenant_id, user_id, name, percentage)
         values ($1, $2, $3, $4, 'Cartão', '0.029900')`,
        [feeId, productId, tenantId, userId],
      );
    }
    await pool.query(
      `insert into market_prices (id, product_id, tenant_id, user_id, min_price, avg_price, max_price)
       values ($1, $2, $3, $4, '20.0000', '24.0000', '30.0000')`,
      [MARKET_A, PRODUCT_A, TENANT_A, USER_A],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("loadDetail respeita o tenant do contexto (cross-tenant = null) e o controle positivo enxerga o próprio", async () => {
    const own = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.loadDetail(context, PRODUCT_A),
    );
    expect(own?.product.id).toBe(PRODUCT_A);
    expect(own?.ingredients.map((row) => row.id)).toEqual([INGREDIENT_A]);
    expect(own?.packaging.map((row) => row.id)).toEqual([PACKAGING_A]);
    expect(own?.fees.map((row) => row.id)).toEqual([FEE_A]);
    expect(own?.market?.id).toBe(MARKET_A);

    for (const [tenantId, userId, productId] of [
      [TENANT_A, USER_A, PRODUCT_B],
      [TENANT_B, USER_B, PRODUCT_A],
    ] as const) {
      const cross = await asTenant(tenantId, userId, (context) =>
        productRepository.loadDetail(context, productId),
      );
      expect(cross).toBeNull();
    }

    const other = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadDetail(context, PRODUCT_B),
    );
    expect(other?.product.id).toBe(PRODUCT_B);
    expect(other?.fees.map((row) => row.id)).toEqual([FEE_B]);
  });

  it("a sessão de prova roda como app_runtime e o RLS esconde as linhas do outro tenant", async () => {
    const [row] = rowsOf(
      await asTenant(TENANT_A, USER_A, (context) =>
        // §9.2 — a sonda roda SQL: estreita o handle neutro para o driver.
        (context.transaction as DatabaseTransaction).execute(sql`
          select current_user as role,
                 (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls,
                 (select count(*) from product_ingredients) as visible_ingredients,
                 (select count(*) from product_ingredients where tenant_id = ${TENANT_B}) as foreign_ingredients
        `),
      ),
    );
    expect(row?.role).toBe("app_runtime");
    expect(row?.bypass_rls).toBe(false);
    expect(Number(row?.visible_ingredients)).toBeGreaterThan(0);
    expect(Number(row?.foreign_ingredients)).toBe(0);
  });

  it("loadReadModel devolve 0 linhas do outro tenant e o read model do dono não é vazio", async () => {
    const rowsA = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.loadReadModel(context),
    );
    expect(rowsA.products.map((row) => row.id)).toEqual([PRODUCT_A]);
    expect(rowsA.ingredients.map((row) => row.id)).toEqual([INGREDIENT_A]);
    expect(rowsA.packaging.map((row) => row.id)).toEqual([PACKAGING_A]);
    expect(rowsA.fees.map((row) => row.id)).toEqual([FEE_A]);
    expect(rowsA.market.map((row) => row.id)).toEqual([MARKET_A]);
    const foreignRows = [
      ...rowsA.products,
      ...rowsA.ingredients,
      ...rowsA.packaging,
      ...rowsA.fees,
      ...rowsA.market,
    ].filter((row) => row.tenantId === TENANT_B);
    expect(foreignRows).toHaveLength(0);

    const rowsB = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadReadModel(context),
    );
    expect(rowsB.products.map((row) => row.id)).toEqual([PRODUCT_B]);
    expect(rowsB.market).toHaveLength(0);
  });

  it("loadPurchasePriceRows devolve só produtos/filhos do tenant do contexto", async () => {
    const rowsA = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.loadPurchasePriceRows(context),
    );
    expect(rowsA.products).toEqual([{ id: PRODUCT_A, name: expect.any(String) }]);
    expect(rowsA.ingredients.map((row) => row.id)).toEqual([INGREDIENT_A]);
    expect(rowsA.packaging.map((row) => row.id)).toEqual([PACKAGING_A]);

    const rowsB = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadPurchasePriceRows(context),
    );
    expect(rowsB.products).toEqual([{ id: PRODUCT_B, name: expect.any(String) }]);
    expect(rowsB.ingredients.map((row) => row.id)).toEqual([INGREDIENT_B]);
    expect(rowsB.packaging.map((row) => row.id)).toEqual([PACKAGING_B]);
  });

  it("saveIngredient insere sob o tenant do contexto e recusa update cross-tenant", async () => {
    const created = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.saveIngredient(context, {
        productId: PRODUCT_A,
        name: "Açúcar",
        usedQty: "0.500000",
        usedUnit: "kg",
        packagePrice: "4.1000",
        packageQty: "1.000000",
        packageUnit: "kg",
        conversionFactor: null,
        priceUpdatedAt: new Date("2026-09-17T10:00:00.000Z"),
      }),
    );
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.userId).toBe(USER_A);
    expect(created.id).not.toBe(INGREDIENT_A);

    const updated = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.saveIngredient(context, {
        id: created.id,
        productId: PRODUCT_A,
        name: "Açúcar mascavo",
        usedQty: "0.600000",
        usedUnit: "kg",
        packagePrice: null,
        packageQty: null,
        packageUnit: null,
        conversionFactor: null,
        priceUpdatedAt: null,
      }),
    );
    expect(updated.name).toBe(NEW_INGREDIENT_NAME);

    await expect(
      asTenant(TENANT_A, USER_A, (context) =>
        productRepository.saveIngredient(context, {
          id: INGREDIENT_B,
          productId: PRODUCT_B,
          name: "invasão",
          usedQty: "1.000000",
          usedUnit: "kg",
          packagePrice: null,
          packageQty: null,
          packageUnit: null,
          conversionFactor: null,
          priceUpdatedAt: null,
        }),
      ),
    ).rejects.toThrow("NOT_FOUND");

    const rowsB = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadDetail(context, PRODUCT_B),
    );
    expect(rowsB?.ingredients.map((row) => row.name)).toEqual(["Farinha"]);

    const readModelB = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadReadModel(context),
    );
    expect(readModelB.ingredients.map((row) => row.id)).not.toContain(created.id);
    expect(readModelB.ingredients.map((row) => row.name)).toEqual(["Farinha"]);
  });

  it("savePackaging/saveFee/createMarketPrice gravam no tenant do contexto", async () => {
    const packaging = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.savePackaging(context, {
        productId: PRODUCT_A,
        name: "Pote",
        packagePrice: "2.0000",
        unitsPerPackage: "6.000000",
        priceUpdatedAt: new Date("2026-09-17T10:00:00.000Z"),
      }),
    );
    expect(packaging.tenantId).toBe(TENANT_A);

    const fee = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.saveFee(context, {
        productId: PRODUCT_A,
        name: "Imposto",
        percentage: "0.120000",
      }),
    );
    expect(fee.tenantId).toBe(TENANT_A);

    const market = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.createMarketPrice(context, {
        productId: PRODUCT_A,
        minPrice: "21.0000",
        avgPrice: "25.0000",
        maxPrice: "31.0000",
      }),
    );
    expect(market.tenantId).toBe(TENANT_A);

    const crossPackaging = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.loadDetail(context, PRODUCT_B),
    );
    expect(crossPackaging).toBeNull();
  });

  it("deleteChild remove a linha do próprio tenant nos 3 filhos e devolve NOT_FOUND no cross-tenant", async () => {
    const ingredient = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.saveIngredient(context, {
        productId: PRODUCT_A,
        name: "Sal",
        usedQty: "0.010000",
        usedUnit: "kg",
        packagePrice: null,
        packageQty: null,
        packageUnit: null,
        conversionFactor: null,
        priceUpdatedAt: null,
      }),
    );
    const packaging = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.savePackaging(context, {
        productId: PRODUCT_A,
        name: "Saco",
        packagePrice: "0.2000",
        unitsPerPackage: "1.000000",
        priceUpdatedAt: new Date("2026-09-17T10:00:00.000Z"),
      }),
    );

    for (const [kind, foreignId] of [
      ["ingredient", INGREDIENT_B],
      ["packaging", PACKAGING_B],
      ["fee", FEE_B],
    ] as const) {
      await expect(
        asTenant(TENANT_A, USER_A, (context) =>
          productRepository.deleteChild(context, kind, foreignId),
        ),
      ).rejects.toThrow("NOT_FOUND");
    }

    for (const [kind, ownId] of [
      ["ingredient", ingredient.id],
      ["packaging", packaging.id],
      ["fee", FEE_A],
    ] as const) {
      await asTenant(TENANT_A, USER_A, (context) =>
        productRepository.deleteChild(context, kind, ownId),
      );
    }

    const own = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.loadDetail(context, PRODUCT_A),
    );
    expect(own?.fees.map((row) => row.id)).not.toContain(FEE_A);
    expect(own?.ingredients.map((row) => row.id)).not.toContain(ingredient.id);
    expect(own?.packaging.map((row) => row.id)).not.toContain(packaging.id);

    const foreign = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadDetail(context, PRODUCT_B),
    );
    expect(foreign?.fees.map((row) => row.id)).toEqual([FEE_B]);
    expect(foreign?.ingredients.map((row) => row.id)).toEqual([INGREDIENT_B]);
    expect(foreign?.packaging.map((row) => row.id)).toEqual([PACKAGING_B]);
  });

  it("updateIngredientPrice/updatePackagingPrice gravam só na linha do tenant e recusam cross-tenant", async () => {
    const priceUpdatedAt = new Date("2026-09-17T11:00:00.000Z");
    const ingredient = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.updateIngredientPrice(context, {
        id: INGREDIENT_A,
        packagePrice: "9.5000",
        packageQty: "5.000000",
        packageUnit: "kg",
        priceUpdatedAt,
      }),
    );
    expect(ingredient.packagePrice).toBe("9.5000");
    expect(ingredient.priceUpdatedAt?.toISOString()).toBe(priceUpdatedAt.toISOString());

    const packaging = await asTenant(TENANT_A, USER_A, (context) =>
      productRepository.updatePackagingPrice(context, {
        id: PACKAGING_A,
        packagePrice: "1.7500",
        unitsPerPackage: "12.000000",
        priceUpdatedAt,
      }),
    );
    expect(packaging.packagePrice).toBe("1.7500");

    for (const operation of [
      (context: RequestContext) =>
        productRepository.updateIngredientPrice(context, {
          id: INGREDIENT_B,
          packagePrice: "0.0001",
          packageQty: "1.000000",
          packageUnit: "kg",
          priceUpdatedAt,
        }),
      (context: RequestContext) =>
        productRepository.updatePackagingPrice(context, {
          id: PACKAGING_B,
          packagePrice: "0.0001",
          unitsPerPackage: "1.000000",
          priceUpdatedAt,
        }),
    ]) {
      await expect(asTenant(TENANT_A, USER_A, operation)).rejects.toThrow("NOT_FOUND");
    }

    const rowsB = await asTenant(TENANT_B, USER_B, (context) =>
      productRepository.loadDetail(context, PRODUCT_B),
    );
    expect(rowsB?.ingredients[0]?.packagePrice).toBe("8.9000");
    expect(rowsB?.packaging[0]?.packagePrice).toBe("1.2000");
  });

  it("savePackaging/saveFee recusam update cross-tenant com NOT_FOUND", async () => {
    await expect(
      asTenant(TENANT_A, USER_A, (context) =>
        productRepository.savePackaging(context, {
          id: PACKAGING_B,
          productId: PRODUCT_B,
          name: "invasão",
          packagePrice: "0.0001",
          unitsPerPackage: "1.000000",
          priceUpdatedAt: new Date(),
        }),
      ),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      asTenant(TENANT_A, USER_A, (context) =>
        productRepository.saveFee(context, {
          id: FEE_B,
          productId: PRODUCT_B,
          name: "invasão",
          percentage: "0.500000",
        }),
      ),
    ).rejects.toThrow("NOT_FOUND");
  });
});
