import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { drizzle } from "drizzle-orm/node-postgres";
import { DatabaseError, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { ApplicationError } from "@/lib/api-error";
import { deleteIngredient, deletePackaging } from "@/lib/products.functions";
import type { RequestContext } from "@/lib/request-context";
import { ensureRuntimeRoleMembership, runMigrations } from "../../scripts/db/migrate";
import { dbPrecondition, skipLabel } from "./helpers/db-precondition";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    };
    return builder;
  },
}));

const TENANT = "c4100000-0000-4000-8000-000000000001";
const USER = "c4100000-0000-4000-8000-000000000002";
const PRODUCT = "c4100000-0000-4000-8000-000000000003";
const INGREDIENT = "c4100000-0000-4000-8000-000000000004";
const PACKAGING = "c4100000-0000-4000-8000-000000000005";
const HISTORY_INGREDIENT = "c4100000-0000-4000-8000-000000000006";
const HISTORY_PACKAGING = "c4100000-0000-4000-8000-000000000007";
const MISSING_CHILD = "c4100000-0000-4000-8000-0000000000ff";
const CORRELATION_ID = "c4100000-0000-4000-8000-0000000000c1";

/**
 * Nomes **reais** das constraints de `purchase_price_history`, medidos no banco
 * (PG17 efêmero): o literal da migration `0004_giant_nocturne.sql` tem 79/82
 * caracteres e o PostgreSQL trunca identificadores em 63 bytes (`NAMEDATALEN`).
 * O nome truncado é o que o driver devolve em `DatabaseError.constraint`.
 */
const HISTORY_INGREDIENT_FK = "purchase_price_history_tenant_id_ingredient_id_product_ingredie";
const HISTORY_PACKAGING_FK = "purchase_price_history_tenant_id_packaging_id_product_packaging";
/** FK hipotética de outra tabela: hoje nenhuma outra FK referencia os filhos do
 * produto (medido em `pg_constraint`), então o ramo genérico só é alcançável
 * por este erro sintético — e é ele que separa F-C6-1 de "qualquer 23503". */
const FOREIGN_FK = "another_table_tenant_id_ingredient_id_fk";
const HISTORY_MESSAGE = "O registro possui histórico de preços e não pode ser removido.";
const FOREIGN_KEY_MESSAGE =
  "O registro está referenciado por outros registros e não pode ser removido.";

type Handler = (input: {
  data: { id: string };
  context: { requestContext: RequestContext };
}) => Promise<unknown>;

function contextFor(transaction: RequestContext["transaction"]): RequestContext {
  return {
    userId: USER,
    tenantId: TENANT,
    roles: ["owner"],
    correlationId: CORRELATION_ID,
    signal: AbortSignal.timeout(15_000),
    transaction,
  };
}

function invokeDelete(handler: unknown, id: string, context: RequestContext): Promise<unknown> {
  return (handler as Handler)({ data: { id }, context: { requestContext: context } });
}

/**
 * Erro **com o shape real do driver**: o `drizzle-orm@0.45` embrulha a falha do
 * node-postgres em `DrizzleQueryError` (sem `code`) com o `DatabaseError` do
 * driver — onde mora o SQLSTATE — em `.cause`.
 */
function drizzleWrappedError(code: string, constraint?: string): DrizzleQueryError {
  const driverError = new DatabaseError(
    `update or delete on table "product_ingredients" violates foreign key constraint "${constraint ?? "unknown_fk"}" on table "purchase_price_history"`,
    0,
    "error",
  );
  driverError.code = code;
  if (constraint !== undefined) driverError.constraint = constraint;
  return new DrizzleQueryError(
    'delete from "product_ingredients" where "id" = $1',
    [INGREDIENT],
    driverError,
  );
}

/**
 * Transação falsa: só o driver é substituído — `deleteProductChild`, o serviço e
 * o repositório reais rodam. `delete()` devolve a cadeia mínima consumida por
 * `DrizzleProductRepository.deleteChild` e rejeita com `error` no `returning()`.
 */
function failingDeleteTransaction(error: unknown): RequestContext["transaction"] {
  const chain: { where: () => unknown; returning: () => Promise<never> } = {
    where: () => chain,
    returning: () => Promise.reject(error),
  };
  return { delete: () => chain } as unknown as RequestContext["transaction"];
}

/** Embrulha `error` em `count` erros genéricos — cada embrulho é um elo extra da
 * cadeia de causas (o `depth` que `foreignKeyViolation` percorre). */
function wrapCause(error: unknown, count: number): unknown {
  let current = error;
  for (let index = 0; index < count; index += 1) {
    current = Object.assign(new Error(`wrapper ${index + 1}`), { cause: current });
  }
  return current;
}

describe("mapeamento FK 23503 → CONFLICT (WP-C4-1)", () => {
  it("deleteIngredient mapeia o erro embrulhado pelo Drizzle (cause.code = 23503) para CONFLICT/409", async () => {
    const wrapped = drizzleWrappedError("23503", HISTORY_INGREDIENT_FK);
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(wrapped))),
    ).rejects.toMatchObject({
      name: "ApplicationError",
      code: "CONFLICT",
      status: 409,
      retryable: false,
      cause: wrapped,
      message: HISTORY_MESSAGE,
    });
  });

  it("deletePackaging usa o mesmo mapeamento (constraint de embalagem)", async () => {
    const error = await invokeDelete(
      deletePackaging,
      PACKAGING,
      contextFor(failingDeleteTransaction(drizzleWrappedError("23503", HISTORY_PACKAGING_FK))),
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: HISTORY_MESSAGE,
    });
  });

  it("F-C6-1: 23503 de FK alheia não herda a mensagem de histórico", async () => {
    const wrapped = drizzleWrappedError("23503", FOREIGN_FK);
    const error = await invokeDelete(
      deleteIngredient,
      INGREDIENT,
      contextFor(failingDeleteTransaction(wrapped)),
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      cause: wrapped,
      message: FOREIGN_KEY_MESSAGE,
    });
    expect((error as Error).message).not.toBe(HISTORY_MESSAGE);
  });

  it("profundidade: o SQLSTATE em depth=2 é encontrado com uma constraint a mais", async () => {
    const wrapped = drizzleWrappedError("23503", HISTORY_INGREDIENT_FK);
    const deep = wrapCause(wrapped, 1);
    const error = await invokeDelete(
      deleteIngredient,
      INGREDIENT,
      contextFor(failingDeleteTransaction(deep)),
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      cause: deep,
      message: HISTORY_MESSAGE,
    });
  });

  it("fronteira: um 23503 no último elo inspecionado (depth=3) ainda é encontrado", async () => {
    const deep = wrapCause(drizzleWrappedError("23503", HISTORY_INGREDIENT_FK), 2);
    const error = await invokeDelete(
      deleteIngredient,
      INGREDIENT,
      contextFor(failingDeleteTransaction(deep)),
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      cause: deep,
      message: HISTORY_MESSAGE,
    });
  });

  it("fronteira: um 23503 em depth=4 (o primeiro elo fora do limite) é relançado como veio", async () => {
    const deep = wrapCause(drizzleWrappedError("23503", HISTORY_INGREDIENT_FK), 3);
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(deep))),
    ).rejects.toBe(deep);
  });

  it("profundidade: um 23503 em depth=5 fica bem fora do limite e é relançado como veio", async () => {
    const deep = wrapCause(drizzleWrappedError("23503", HISTORY_INGREDIENT_FK), 4);
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(deep))),
    ).rejects.toBe(deep);
  });

  it("controle negativo: outro SQLSTATE (23505) é relançado como veio", async () => {
    const other = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(other))),
    ).rejects.toBe(other);
  });

  it("controle negativo: erro sem cadeia de causas é relançado como veio", async () => {
    const notFound = new Error("NOT_FOUND");
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(notFound))),
    ).rejects.toBe(notFound);
  });

  it("controle negativo: `cause` primitiva (string) encerra a busca sem virar CONFLICT", async () => {
    const primitive = Object.assign(new Error("wrapper"), { cause: "23503" });
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(primitive))),
    ).rejects.toBe(primitive);
  });

  it("limite de profundidade: cadeia circular não trava", async () => {
    const circular = new Error("circular");
    Object.assign(circular, { cause: circular });
    await expect(
      invokeDelete(deleteIngredient, INGREDIENT, contextFor(failingDeleteTransaction(circular))),
    ).rejects.toBe(circular);
  });
});

/**
 * Prova em banco descartável (PG local efêmero): o caminho real do driver — sem
 * dublê — devolve CONFLICT/409 ao apagar filho com histórico de preços. A
 * sessão roda como `app_runtime` (NOSUPERUSER/NOBYPASSRLS) com GUCs do tenant,
 * mesma técnica de `product-contracts.test.ts`.
 *
 * Gate fail-closed: qualquer URL fora de loopback (ou a credencial herdada de
 * produção `DATABASE_URL_UNPOOLED`) desabilita o bloco.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const dbGate = dbPrecondition();
if (!dbGate.enabled) console.log(skipLabel(dbGate.motivo));
const dbDescribe = dbGate.enabled ? describe : describe.skip;

dbDescribe("delete de filho com histórico — caminho real do driver (PG efêmero)", () => {
  const pool = new Pool({ connectionString: adminUrl ?? "", max: 2 });
  const database = drizzle({ client: pool, schema });

  beforeAll(async () => {
    await runMigrations(adminUrl);
    await ensureRuntimeRoleMembership(pool);
    await pool.query("delete from purchase_price_history where tenant_id = $1", [TENANT]);
    await pool.query("delete from product_ingredients where tenant_id = $1", [TENANT]);
    await pool.query("delete from product_packaging where tenant_id = $1", [TENANT]);
    await pool.query("delete from products where tenant_id = $1", [TENANT]);
    await pool.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'Usuário FK', 'fk-conflict@products-fk.test', true)
       on conflict (id) do update set name = excluded.name`,
      [USER],
    );
    await pool.query(
      `insert into tenants (id, name, slug) values ($1, 'Tenant FK', 'products-fk-conflict')
       on conflict (id) do update set name = excluded.name`,
      [TENANT],
    );
    await pool.query(
      `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'owner')
       on conflict (tenant_id, user_id) do update set role = 'owner'`,
      [TENANT, USER],
    );
    await pool.query(
      `insert into products (id, tenant_id, user_id, name, current_price, yield_qty, yield_unit, status, version)
       values ($1, $2, $3, 'Produto FK', '25.0000', '12.000000', 'unidade', 'active', 0)`,
      [PRODUCT, TENANT, USER],
    );
    await pool.query(
      `insert into product_ingredients
         (id, product_id, tenant_id, user_id, name, used_qty, used_unit, package_price, package_qty, package_unit)
       values ($1, $2, $3, $4, 'Farinha', '1.000000', 'kg', '8.9000', '5.000000', 'kg')`,
      [INGREDIENT, PRODUCT, TENANT, USER],
    );
    await pool.query(
      `insert into product_packaging
         (id, product_id, tenant_id, user_id, name, package_price, units_per_package)
       values ($1, $2, $3, $4, 'Caixa', '1.2000', '10.000000')`,
      [PACKAGING, PRODUCT, TENANT, USER],
    );
    await pool.query(
      `insert into purchase_price_history
         (id, tenant_id, user_id, subject_type, subject_id, ingredient_id, price, quantity, unit, valid_from)
       values ($1, $2, $3, 'ingredient', $4, $4, '8.9000', '5.000000', 'kg', now())`,
      [HISTORY_INGREDIENT, TENANT, USER, INGREDIENT],
    );
    await pool.query(
      `insert into purchase_price_history
         (id, tenant_id, user_id, subject_type, subject_id, packaging_id, price, quantity, unit, valid_from)
       values ($1, $2, $3, 'packaging', $4, $4, '1.2000', '10.000000', 'unidade', now())`,
      [HISTORY_PACKAGING, TENANT, USER, PACKAGING],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  /** Executa `operation` numa transação como `app_runtime` com os GUCs do tenant. */
  async function asTenant(
    operation: (context: RequestContext) => Promise<unknown>,
  ): Promise<unknown> {
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(sql`
        select
          set_config('app.current_user_id', ${USER}, true),
          set_config('app.current_tenant_id', ${TENANT}, true),
          set_config('app.current_roles', 'owner', true)
      `);
      return operation(contextFor(transaction as unknown as RequestContext["transaction"]));
    });
  }

  async function errorFrom(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      await operation();
      return null;
    } catch (error) {
      return error;
    }
  }

  it("ingrediente com histórico ⇒ CONFLICT/409 com a mensagem de histórico (antes: erro cru do driver)", async () => {
    const error = await errorFrom(() =>
      asTenant((context) => invokeDelete(deleteIngredient, INGREDIENT, context)),
    );
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      retryable: false,
      message: HISTORY_MESSAGE,
    });
  });

  it("embalagem com histórico ⇒ CONFLICT/409 com a mensagem de histórico", async () => {
    const error = await errorFrom(() =>
      asTenant((context) => invokeDelete(deletePackaging, PACKAGING, context)),
    );
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: HISTORY_MESSAGE,
    });
  });

  it("controle negativo: filho inexistente ⇒ NOT_FOUND, nunca CONFLICT", async () => {
    const error = await errorFrom(() =>
      asTenant((context) => invokeDelete(deleteIngredient, MISSING_CHILD, context)),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApplicationError);
    expect((error as Error).message).toBe("NOT_FOUND");
  });

  it("controle positivo: histórico restringe o delete de fato (linha preservada)", async () => {
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from purchase_price_history where tenant_id = $1",
      [TENANT],
    );
    expect(rows[0]?.count).toBe("2");
    const children = await pool.query<{ count: string }>(
      "select count(*)::text as count from product_ingredients where tenant_id = $1",
      [TENANT],
    );
    expect(children.rows[0]?.count).toBe("1");
  });
});
