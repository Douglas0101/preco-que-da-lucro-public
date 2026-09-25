import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type Client, type QueryResult } from "pg";
import * as schema from "../../src/db/schema";
import { runRegisteredTool } from "../../src/lib/ai/tool-runner";
import type { RequestContext } from "../../src/lib/request-context";
import { DrizzleProductRepository } from "../../src/server/repositories/product.repository";
import { ensureRuntimeRoleMembership, requireAdminUrl } from "./migrate";

/**
 * §32 — SQL injection adversarial (Prova).
 *
 * Each payload runs twice:
 *  1. positive control: the SAME string is concatenated into SQL inside a
 *     canary transaction that is always rolled back. This proves the payload
 *     is potent when interpolation is vulnerable (canary changes or errors).
 *  2. real paths under `set local role app_runtime`: the `create_product` tool
 *     and `DrizzleProductRepository.save`. Both must store the payload as an
 *     inert byte-identical value.
 *
 * The concatenations below are deliberate attack vectors used ONLY by the
 * control; the application paths never interpolate input into SQL.
 */

const userId = "81000000-0000-4000-8000-000000000001";
const tenantId = "82000000-0000-4000-8000-000000000002";
const correlationId = "83000000-0000-4000-8000-000000000003";

const sleepPayload = "1; SELECT pg_sleep(2); --";
const pwnedPayload = "'); UPDATE products SET name='pwned' WHERE '1'='1'; --";

interface ControlEvidence {
  potent: boolean;
  detail: string;
}

interface PayloadCase {
  payload: string;
  /** Deliberately vulnerable concatenation, executed only by the control. */
  vulnerable: (payload: string) => string;
  prepare?: (client: Client) => Promise<void>;
  assertControl: (context: {
    client: Client;
    result: QueryResult;
    durationMs: number;
  }) => Promise<ControlEvidence>;
}

const cases: PayloadCase[] = [
  {
    payload: "' OR '1'='1",
    vulnerable: (payload) =>
      `select count(*)::int as n from sqli_canary where value = '${payload}'`,
    async assertControl({ client, result }) {
      const selected = Number(result.rows[0]?.n);
      const parameterized = await client.query<{ n: number }>(
        "select count(*)::int as n from sqli_canary where value = $1",
        ["' OR '1'='1"],
      );
      assert.equal(parameterized.rows[0]?.n, 0);
      assert.equal(selected, 1);
      return {
        potent: true,
        detail: `tautologia selecionou ${selected} linha(s) do canário; com $1, 0`,
      };
    },
  },
  {
    payload: "x'); DROP TABLE products; --",
    vulnerable: (payload) => `insert into sqli_canary(value) values ('${payload}')`,
    async assertControl({ client }) {
      const table = await client.query<{ name: string | null }>(
        "select to_regclass('public.products')::text as name",
      );
      assert.equal(table.rows[0]?.name, null);
      return {
        potent: true,
        detail: "concatenação derrubou public.products dentro da transação (rollback restaurou)",
      };
    },
  },
  {
    payload: sleepPayload,
    vulnerable: (payload) => `select count(*)::int as n from sqli_canary where 1 = ${payload}`,
    async assertControl({ durationMs }) {
      assert.ok(
        durationMs >= 1_500,
        `pg_sleep concatenado deveria bloquear >= 1500ms, mediu ${Math.round(durationMs)}ms`,
      );
      return {
        potent: true,
        detail: `pg_sleep(2) concatenado bloqueou por ${Math.round(durationMs)}ms`,
      };
    },
  },
  {
    payload: pwnedPayload,
    vulnerable: (payload) => `insert into sqli_canary(value) values ('${payload}')`,
    prepare: async (client) => {
      await client.query(
        "insert into products (tenant_id, user_id, name) values ($1, $2, 'canario-dml')",
        [tenantId, userId],
      );
    },
    async assertControl({ client }) {
      const pwned = await client.query<{ n: string }>(
        "select count(*)::text as n from products where name = 'pwned'",
      );
      const count = Number(pwned.rows[0]?.n);
      assert.ok(count >= 1, "o UPDATE concatendo deveria ter alterado o produto canário");
      return {
        potent: true,
        detail: `concatenação alterou ${count} linha(s) de products para 'pwned'`,
      };
    },
  },
  {
    payload: '{"$ne":null}',
    vulnerable: (payload) =>
      `select count(*)::int as n from sqli_canary where value = '${payload}'`,
    async assertControl({ client, result }) {
      const onlyCanary = await client.query<{ n: string }>(
        "select count(*)::text as n from sqli_canary",
      );
      assert.equal(result.rows[0]?.n, 0);
      assert.equal(onlyCanary.rows[0]?.n, "1");
      return {
        potent: false,
        detail: "operador NoSQL é literal inerte em SQL; canário permaneceu intacto",
      };
    },
  },
  {
    payload: "%'); COPY (SELECT '') TO PROGRAM 'true'; --",
    vulnerable: (payload) => `insert into sqli_canary(value) values ('${payload}')`,
    async assertControl({ client }) {
      const marker = await client.query<{ n: string }>(
        "select count(*)::text as n from sqli_canary where value = '%'",
      );
      assert.equal(marker.rows[0]?.n, "1");
      return {
        potent: true,
        detail: "concatenação executou INSERT e COPY ... TO PROGRAM 'true' sem erro (papel admin)",
      };
    },
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hexOf(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

async function runPositiveControl(pool: Pool, testCase: PayloadCase): Promise<ControlEvidence> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("create temp table sqli_canary(value text) on commit drop");
    await client.query("insert into sqli_canary(value) values ('canario')");
    await testCase.prepare?.(client);

    const startedAt = performance.now();
    let result: QueryResult | undefined;
    let vulnerableError: unknown;
    try {
      result = await client.query(testCase.vulnerable(testCase.payload));
    } catch (error) {
      vulnerableError = error;
    }
    const durationMs = performance.now() - startedAt;

    let evidence: ControlEvidence;
    if (vulnerableError !== undefined) {
      evidence = {
        potent: true,
        detail: `concatenação aceitou o payload e abortou: ${errorMessage(vulnerableError)}`,
      };
    } else if (result) {
      evidence = await testCase.assertControl({ client, result, durationMs });
    } else {
      throw new Error("controle positivo sem resultado e sem erro");
    }

    await client.query("rollback");
    return evidence;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixtures(pool: Pool): Promise<void> {
  await pool.query("delete from tool_executions where tenant_id = $1", [tenantId]);
  await pool.query("delete from idempotency_records where tenant_id = $1", [tenantId]);
  await pool.query("delete from audit_events where tenant_id = $1", [tenantId]);
  await pool.query("delete from products where tenant_id = $1", [tenantId]);
  await pool.query("delete from tenant_memberships where tenant_id = $1", [tenantId]);
  await pool.query("delete from tenants where id = $1", [tenantId]);
  await pool.query("delete from users where id = $1", [userId]);
}

async function assertProductsTableExists(pool: Pool, context: string): Promise<void> {
  const table = await pool.query<{ name: string | null }>(
    "select to_regclass('public.products')::text as name",
  );
  assert.notEqual(table.rows[0]?.name, null, `public.products deve existir ${context}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 3 });
  const database = drizzle({ client: pool, schema });
  const toolDurations = new Map<string, number>();
  const repositoryDurations = new Map<string, number>();
  const controls = new Map<string, ControlEvidence>();

  try {
    await cleanupFixtures(pool);
    await ensureRuntimeRoleMembership(pool);
    await pool.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'SQLi User', 'sql-injection@example.test', true)`,
      [userId],
    );
    await pool.query(
      `insert into tenants (id, name, slug, kind)
       values ($1, 'SQLi Tenant', 'sql-injection-tenant', 'personal')`,
      [tenantId],
    );
    await pool.query(
      `insert into tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'owner')`,
      [tenantId, userId],
    );

    for (const testCase of cases) {
      const evidence = await runPositiveControl(pool, testCase);
      controls.set(testCase.payload, evidence);
      await assertProductsTableExists(pool, `após o rollback do controle: ${testCase.payload}`);
    }

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(sql`
        select
          set_config('app.current_user_id', ${userId}, true),
          set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_roles', 'owner', true)
      `);
      const context: RequestContext = {
        userId,
        tenantId,
        roles: ["owner"],
        correlationId,
        signal: new AbortController().signal,
        transaction: transaction as unknown as RequestContext["transaction"],
      };

      for (const [index, testCase] of cases.entries()) {
        const startedAt = performance.now();
        const result = await runRegisteredTool({
          context,
          name: "create_product",
          rawArguments: JSON.stringify({ name: testCase.payload }),
          idempotencyKey: `sql-injection:tool:${index}`,
        });
        const durationMs = performance.now() - startedAt;
        toolDurations.set(testCase.payload, durationMs);
        assert.equal(
          result.ok,
          true,
          `create_product deveria armazenar o payload como dado: ${testCase.payload}`,
        );
        if (!result.ok) return;
        assert.equal(result.output.result.name, testCase.payload);

        if (testCase.payload === sleepPayload) {
          assert.ok(
            durationMs < 1_000,
            `caminho parametrizado não pode executar pg_sleep (${Math.round(durationMs)}ms)`,
          );
        }
      }
    });

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(sql`
        select
          set_config('app.current_user_id', ${userId}, true),
          set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_roles', 'owner', true)
      `);
      const context: RequestContext = {
        userId,
        tenantId,
        roles: ["owner"],
        correlationId,
        signal: new AbortController().signal,
        transaction: transaction as unknown as RequestContext["transaction"],
      };
      const repository = new DrizzleProductRepository();

      for (const entry of cases) {
        const startedAt = performance.now();
        const row = await repository.save(context, {
          name: entry.payload,
          currentPrice: null,
          yieldQty: null,
          yieldUnit: null,
          taxRegime: null,
          taxRate: null,
        });
        const durationMs = performance.now() - startedAt;
        repositoryDurations.set(entry.payload, durationMs);
        assert.equal(row.name, entry.payload);

        if (entry.payload === sleepPayload) {
          assert.ok(
            durationMs < 1_000,
            `save parametrizado não pode executar pg_sleep (${Math.round(durationMs)}ms)`,
          );
        }
      }
    });

    await assertProductsTableExists(pool, "ao final do teste");

    const pwnedExact = await pool.query<{ n: string }>(
      "select count(*)::text as n from products where tenant_id = $1 and name = 'pwned'",
      [tenantId],
    );
    assert.equal(pwnedExact.rows[0]?.n, "0", "nenhuma linha pode ter sido alterada para 'pwned'");

    const pwnedLike = await pool.query<{ name: string; hex: string }>(
      `select name, encode(convert_to(name, 'UTF8'), 'hex') as hex
       from products
       where tenant_id = $1 and name like '%pwned%'`,
      [tenantId],
    );
    assert.equal(
      pwnedLike.rows.length,
      2,
      "somente os 2 caminhos podem armazenar o payload (o próprio payload contém 'pwned')",
    );
    for (const row of pwnedLike.rows) {
      assert.equal(row.name, pwnedPayload);
      assert.equal(row.hex, hexOf(pwnedPayload), "linha pwned-like deve ser byte a byte o payload");
    }

    const reports = [];
    for (const testCase of cases) {
      const stored = await pool.query<{ name: string; hex: string }>(
        `select name, encode(convert_to(name, 'UTF8'), 'hex') as hex
         from products
         where tenant_id = $1 and name = $2`,
        [tenantId, testCase.payload],
      );
      assert.equal(
        stored.rows.length,
        2,
        `payload deve aparecer uma vez por caminho: ${testCase.payload}`,
      );
      for (const row of stored.rows) {
        assert.equal(row.name, testCase.payload);
        assert.equal(row.hex, hexOf(testCase.payload), "linha gravada byte a byte");
      }
      const control = controls.get(testCase.payload);
      if (!control) throw new Error(`controle ausente para ${testCase.payload}`);
      reports.push({
        payload: testCase.payload,
        control_potent: control.potent,
        control_evidence: control.detail,
        tool_duration_ms: Math.round(toolDurations.get(testCase.payload) ?? -1),
        repository_duration_ms: Math.round(repositoryDurations.get(testCase.payload) ?? -1),
        stored_rows_byte_identical: stored.rows.length,
      });
    }

    console.log(
      JSON.stringify(
        {
          check: "db:test-sql-injection",
          engine: "postgres",
          payloads: cases.length,
          paths: ["create_product", "DrizzleProductRepository.save"],
          products_table_exists: true,
          pwned_exact_rows: Number(pwnedExact.rows[0]?.n),
          reports,
        },
        null,
        2,
      ),
    );
    console.log("SQL injection adversarial: parametrização resiste aos 6 payloads, 0 mutações: OK");
  } finally {
    await cleanupFixtures(pool).catch((error: unknown) => {
      console.error(JSON.stringify({ check: "db:test-sql-injection", cleanup: String(error) }));
    });
    await pool.end();
  }
}

await main();
