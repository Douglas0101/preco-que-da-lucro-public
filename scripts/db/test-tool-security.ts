import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { runRegisteredTool } from "../../src/lib/ai/tool-runner";
import type { RequestContext } from "../../src/lib/request-context";
import { userRateLimitKey } from "../../src/server/auth/rate-limit-rules.server";
import { ensureRuntimeRoleMembership, requireAdminUrl } from "./migrate";

const userId = "71000000-0000-4000-8000-000000000001";
const tenantId = "72000000-0000-4000-8000-000000000002";
const otherUserId = "73000000-0000-4000-8000-000000000003";
const otherTenantId = "74000000-0000-4000-8000-000000000004";
const otherProductId = "75000000-0000-4000-8000-000000000005";
const correlationId = "76000000-0000-4000-8000-000000000006";
const usageId = "78000000-0000-4000-8000-000000000008";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 2 });
  const database = drizzle({ client: pool, schema });
  try {
    await ensureRuntimeRoleMembership(pool);
    // §20.5: as 12 chamadas deste script consomem o bucket `tool|<userId>`
    // (40/10 min) com userId fixo; sem limpar, a 5ª execução dentro da mesma
    // janela seria recusada com RATE_LIMIT em vez de exercitar o runner.
    await pool.query(`delete from rate_limits where key = $1`, [userRateLimitKey("tool", userId)]);
    await pool.query(
      `insert into users (id, name, email, email_verified) values
        ($1, 'Tool User', 'tool-user@example.test', true),
        ($2, 'Other Tool User', 'other-tool-user@example.test', true)
       on conflict (id) do nothing`,
      [userId, otherUserId],
    );
    await pool.query(
      `insert into tenants (id, name, slug, kind) values
        ($1, 'Tool Tenant', 'tool-tenant', 'personal'),
        ($2, 'Other Tool Tenant', 'other-tool-tenant', 'personal')
       on conflict (id) do nothing`,
      [tenantId, otherTenantId],
    );
    await pool.query(
      `insert into tenant_memberships (tenant_id, user_id, role) values
        ($1, $2, 'owner'),
        ($3, $4, 'owner')
       on conflict (tenant_id, user_id) do nothing`,
      [tenantId, userId, otherTenantId, otherUserId],
    );
    await pool.query(
      `insert into products (id, tenant_id, user_id, name)
       values ($1, $2, $3, 'Produto de outro tenant')
       on conflict (id) do nothing`,
      [otherProductId, otherTenantId, otherUserId],
    );
    await pool.query(
      `delete from idempotency_records
       where tenant_id = $1 and user_id = $2
         and operation = 'ai.tool.create_product'
         and key = 'conversation:expired'`,
      [tenantId, userId],
    );
    await pool.query(
      `insert into idempotency_records
        (id, tenant_id, user_id, operation, key, request_hash, status, expires_at)
       values
        ('77000000-0000-4000-8000-000000000007', $1, $2,
         'ai.tool.create_product', 'conversation:expired', 'stale-hash', 'pending',
         now() - interval '1 minute')`,
      [tenantId, userId],
    );

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
        // SAFETY: the harness drives a real RLS-scoped driver transaction (the GUCs
        // are set just above) and the app's `RequestContext.transaction` is an opaque
        // handle, so the cast is the boundary between the raw driver type and that
        // handle. The runner only issues queries through it.
        transaction: transaction as unknown as RequestContext["transaction"],
      };

      const first = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Bolo auditável" }),
        idempotencyKey: "conversation:call-create",
        toolCallId: "call-create-product",
        usageId,
      });
      assert.equal(first.ok, true);
      assert.equal(first.replayed, false);

      const replay = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Bolo auditável" }),
        idempotencyKey: "conversation:call-create",
        toolCallId: "call-create-product",
        usageId,
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);

      const conflictingReplay = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Outro produto para a mesma chave" }),
        idempotencyKey: "conversation:call-create",
      });
      assert.deepEqual(conflictingReplay, {
        ok: false,
        code: "CONFLICT",
        replayed: false,
      });

      const expired = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Chave reciclada" }),
        idempotencyKey: "conversation:expired",
      });
      assert.equal(expired.ok, true);
      assert.equal(expired.replayed, false);

      const invalid = await runRegisteredTool({
        context,
        name: "set_yield",
        rawArguments: JSON.stringify({
          product_id: otherProductId,
          yield_qty: null,
          yield_unit: "un",
        }),
        idempotencyKey: "conversation:call-invalid",
      });
      assert.deepEqual(invalid, { ok: false, code: "VALIDATION_ERROR", replayed: false });

      const unauthorized = await runRegisteredTool({
        context: { ...context, roles: ["viewer"] },
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Não pode existir" }),
        idempotencyKey: "conversation:call-unauthorized",
      });
      assert.deepEqual(unauthorized, {
        ok: false,
        code: "AUTHORIZATION_ERROR",
        replayed: false,
      });

      const stateBlocked = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Estado não permite" }),
        idempotencyKey: "conversation:state-blocked",
        allowedToolNames: ["set_yield"],
        requireConfirmation: true,
        confirmed: true,
      });
      assert.deepEqual(stateBlocked, {
        ok: false,
        code: "AUTHORIZATION_ERROR",
        replayed: false,
      });

      const confirmationBlocked = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: JSON.stringify({ name: "Sem confirmação" }),
        idempotencyKey: "conversation:confirmation-blocked",
        allowedToolNames: ["create_product"],
        requireConfirmation: true,
        confirmed: false,
      });
      assert.deepEqual(confirmationBlocked, {
        ok: false,
        code: "AUTHORIZATION_ERROR",
        replayed: false,
      });

      const unknownTool = await runRegisteredTool({
        context,
        name: "tool_desconhecida",
        rawArguments: JSON.stringify({
          name: "x",
          authorization: "Bearer super-secret",
          api_key: "chave-secreta",
          cookie: "session=abc",
        }),
        idempotencyKey: "conversation:call-unknown",
        toolCallId: "call-unknown",
        usageId,
      });
      assert.deepEqual(unknownTool, { ok: false, code: "VALIDATION_ERROR", replayed: false });

      const invalidJson = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: "{não-é-json",
        idempotencyKey: "conversation:call-invalid-json",
        toolCallId: "call-invalid-json",
        usageId,
      });
      assert.deepEqual(invalidJson, { ok: false, code: "VALIDATION_ERROR", replayed: false });

      const loneSurrogate = await runRegisteredTool({
        context,
        name: "create_product",
        rawArguments: '{"name":"Bolo \\ud83d solto"}',
        idempotencyKey: "conversation:call-lone-surrogate",
        toolCallId: "call-lone-surrogate",
        usageId,
      });
      assert.equal(loneSurrogate.ok, true);
      assert.equal(loneSurrogate.replayed, false);

      const crossTenant = await runRegisteredTool({
        context,
        name: "set_yield",
        rawArguments: JSON.stringify({
          product_id: otherProductId,
          yield_qty: "10.000000",
          yield_unit: "un",
        }),
        idempotencyKey: "conversation:call-cross-tenant",
      });
      assert.equal(crossTenant.ok, false);
      if (!crossTenant.ok) assert.equal(crossTenant.code, "NOT_FOUND");
    });

    const products = await pool.query<{ count: string }>(
      "select count(*)::text as count from products where tenant_id = $1 and name = 'Bolo auditável'",
      [tenantId],
    );
    assert.equal(products.rows[0]?.count, "1", "replay idempotente não pode duplicar mutação");
    const forbidden = await pool.query<{ count: string }>(
      "select count(*)::text as count from products where tenant_id = $1 and name = 'Não pode existir'",
      [tenantId],
    );
    assert.equal(forbidden.rows[0]?.count, "0", "tool não autorizada não pode mutar");
    const executions = await pool.query<{ count: string }>(
      "select count(*)::text as count from tool_executions where tenant_id = $1",
      [tenantId],
    );
    assert.equal(executions.rows[0]?.count, "10", "execuções e rejeições devem ser auditadas");
    const rejectedAudit = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where tenant_id = $1 and event_type = 'ai.tool.rejected'",
      [tenantId],
    );
    assert.equal(rejectedAudit.rows[0]?.count, "6", "rejeições devem gerar audit_event");

    const persistedExecution = await pool.query<{
      tool_call_id: string | null;
      usage_id: string | null;
      input: Record<string, unknown> | null;
    }>(
      `select tool_call_id, usage_id, input
       from tool_executions
       where tenant_id = $1 and tool_call_id = 'call-create-product'`,
      [tenantId],
    );
    assert.equal(persistedExecution.rows[0]?.tool_call_id, "call-create-product");
    assert.equal(persistedExecution.rows[0]?.usage_id, usageId);
    assert.deepEqual(
      persistedExecution.rows[0]?.input,
      { name: "Bolo auditável" },
      "input validado deve ser persistido no tool_executions",
    );

    const redactedExecution = await pool.query<{ input: Record<string, unknown> | null }>(
      "select input from tool_executions where tenant_id = $1 and tool_call_id = 'call-unknown'",
      [tenantId],
    );
    assert.deepEqual(
      redactedExecution.rows[0]?.input,
      {
        name: "x",
        authorization: "[REDACTED]",
        api_key: "[REDACTED]",
        cookie: "[REDACTED]",
      },
      "rejeição deve persistir input com chaves sensíveis redigidas",
    );

    const invalidInputExecution = await pool.query<{ input: Record<string, unknown> | null }>(
      "select input from tool_executions where tenant_id = $1 and tool_call_id = 'call-invalid-json'",
      [tenantId],
    );
    assert.equal(
      invalidInputExecution.rows[0]?.input,
      null,
      "JSON inválido deve persistir input null",
    );

    const surrogateExecution = await pool.query<{ input: Record<string, unknown> | null }>(
      "select input from tool_executions where tenant_id = $1 and tool_call_id = 'call-lone-surrogate'",
      [tenantId],
    );
    assert.deepEqual(
      surrogateExecution.rows[0]?.input,
      { name: "Bolo  solto" },
      "escape lone surrogate deve ser removido antes do insert jsonb",
    );

    const sensitiveKeys = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from tool_executions, jsonb_each_text(input) as entry(key, value)
       where tenant_id = $1
         and lower(regexp_replace(entry.key, '[^a-zA-Z0-9]', '', 'g')) in
             ('authorization', 'cookie', 'token', 'secret', 'password', 'apikey')
         and entry.value <> '[REDACTED]'`,
      [tenantId],
    );
    assert.equal(
      sensitiveKeys.rows[0]?.count,
      "0",
      "chave sensível persistida deve estar redigida com [REDACTED]",
    );

    const rawSecrets = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from tool_executions
       where tenant_id = $1
         and (input::text like '%super-secret%'
           or input::text like '%chave-secreta%'
           or input::text like '%session=abc%')`,
      [tenantId],
    );
    assert.equal(rawSecrets.rows[0]?.count, "0", "nenhum valor secreto cru pode ser persistido");
  } finally {
    await pool.end();
  }

  console.log("Tool registry: validação, AuthZ, idempotência, auditoria e isolamento: OK");
}

await main();
