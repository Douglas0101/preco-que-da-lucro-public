import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import type { RequestContext } from "../../src/lib/request-context";
import { DrizzleProductRepository } from "../../src/server/repositories/product.repository";
import { DrizzleExpenseRepository } from "../../src/server/repositories/expense.repository";
import { requireAdminUrl } from "./migrate";

const userId = "91000000-0000-4000-8000-000000000001";
const tenantId = "92000000-0000-4000-8000-000000000002";
const productId = "93000000-0000-4000-8000-000000000003";
const expenseId = "94000000-0000-4000-8000-000000000004";
const missingProductId = "95000000-0000-4000-8000-000000000005";

const productRepository = new DrizzleProductRepository();
const expenseRepository = new DrizzleExpenseRepository();

function contextFor(
  transaction: RequestContext["transaction"],
  correlationId: string,
): RequestContext {
  return {
    userId,
    tenantId,
    roles: ["owner"],
    correlationId,
    signal: AbortSignal.timeout(15_000),
    transaction,
  };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 2 });
  const database = drizzle({ client: pool, schema });
  try {
    await pool.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'Concurrency User', 'concurrency@example.test', true)
       on conflict (id) do nothing`,
      [userId],
    );
    await pool.query(
      `insert into tenants (id, name, slug) values ($1, 'Concurrency Tenant', 'concurrency-tenant')
       on conflict (id) do nothing`,
      [tenantId],
    );
    await pool.query(
      `insert into tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'owner')
       on conflict (tenant_id, user_id) do nothing`,
      [tenantId, userId],
    );
    await pool.query("delete from products where tenant_id = $1 and id = $2", [
      tenantId,
      productId,
    ]);
    await pool.query("delete from expenses where tenant_id = $1 and id = $2", [
      tenantId,
      expenseId,
    ]);
    await pool.query(
      `insert into products (id, tenant_id, user_id, name, current_price, version)
       values ($1, $2, $3, 'Produto concorrente', '10.0000', 0)`,
      [productId, tenantId, userId],
    );
    await pool.query(
      `insert into expenses (id, tenant_id, user_id, name, amount, type, version)
       values ($1, $2, $3, 'Despesa concorrente', '50.0000', 'fixa', 0)`,
      [expenseId, tenantId, userId],
    );

    // Burst produto: duas transações concorrentes partem da mesma version 0.
    const updateProduct = (expectedVersion: number, name: string) =>
      database.transaction((transaction) =>
        productRepository.save(contextFor(transaction, "concurrency-product"), {
          id: productId,
          version: expectedVersion,
          name,
          currentPrice: "12.3400",
          yieldQty: null,
          yieldUnit: null,
          taxRegime: null,
          taxRate: null,
        }),
      );

    const productBurst = await Promise.allSettled([
      updateProduct(0, "Produto vencedor A"),
      updateProduct(0, "Produto vencedor B"),
    ]);
    const productWins = productBurst.filter((result) => result.status === "fulfilled");
    const productConflicts = productBurst.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof Error &&
        result.reason.message === "CONFLICT",
    );
    assert.equal(productWins.length, 1, "exatamente um update deve vencer o burst de produto");
    assert.equal(productConflicts.length, 1, "exatamente um update deve receber CONFLICT");

    const productRows = await pool.query<{ version: number; name: string }>(
      "select version, name from products where id = $1",
      [productId],
    );
    const productRow = productRows.rows[0];
    assert.equal(productRow?.version, 1, "version deve incrementar exatamente uma vez");
    assert.ok(
      productRow?.name === "Produto vencedor A" || productRow?.name === "Produto vencedor B",
      "a linha final deve pertencer a um dos vencedores",
    );

    // Reuso da version antiga (stale) após o burst → CONFLICT.
    await assert.rejects(
      updateProduct(0, "Produto stale"),
      (error: unknown) => error instanceof Error && error.message === "CONFLICT",
      "update com version obsoleta deve falhar com CONFLICT",
    );

    // Id inexistente → NOT_FOUND (não CONFLICT).
    await assert.rejects(
      database.transaction((transaction) =>
        productRepository.save(contextFor(transaction, "concurrency-missing"), {
          id: missingProductId,
          version: 0,
          name: "Produto fantasma",
          currentPrice: null,
          yieldQty: null,
          yieldUnit: null,
          taxRegime: null,
          taxRate: null,
        }),
      ),
      (error: unknown) => error instanceof Error && error.message === "NOT_FOUND",
      "id inexistente deve falhar com NOT_FOUND",
    );

    // O update vencedor com a version corrente segue funcionando.
    await updateProduct(1, "Produto atualizado");
    const productAfterRows = await pool.query<{ version: number; name: string }>(
      "select version, name from products where id = $1",
      [productId],
    );
    const productAfter = productAfterRows.rows[0];
    assert.equal(productAfter?.version, 2);
    assert.equal(productAfter?.name, "Produto atualizado");

    // Burst despesa: mesmo contrato CAS.
    const updateExpense = (expectedVersion: number, notes: string) =>
      database.transaction((transaction) =>
        expenseRepository.save(contextFor(transaction, "concurrency-expense"), {
          id: expenseId,
          version: expectedVersion,
          name: "Despesa concorrente",
          category: null,
          amount: "50.0000",
          type: "fixa",
          periodicity: "mensal",
          notes,
        }),
      );

    const expenseBurst = await Promise.allSettled([
      updateExpense(0, "nota A"),
      updateExpense(0, "nota B"),
    ]);
    const expenseWins = expenseBurst.filter((result) => result.status === "fulfilled");
    const expenseConflicts = expenseBurst.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof Error &&
        result.reason.message === "CONFLICT",
    );
    assert.equal(expenseWins.length, 1, "exatamente um update deve vencer o burst de despesa");
    assert.equal(expenseConflicts.length, 1, "exatamente um update deve receber CONFLICT");

    const expenseRows = await pool.query<{ version: number }>(
      "select version from expenses where id = $1",
      [expenseId],
    );
    const expenseRow = expenseRows.rows[0];
    assert.equal(expenseRow?.version, 1, "version da despesa deve incrementar uma vez");

    console.log(
      "T2 CAS: produto e despesa com 1 update OK + 1 CONFLICT por burst + version incrementada: OK",
    );
  } finally {
    await pool.query("delete from expenses where tenant_id = $1 and id = $2", [
      tenantId,
      expenseId,
    ]);
    await pool.query("delete from products where tenant_id = $1 and id = $2", [
      tenantId,
      productId,
    ]);
    await pool.end();
  }
}

await main();
