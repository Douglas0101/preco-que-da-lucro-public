/**
 * §23 — outbox transacional (23.1) e worker idempotente (23.2).
 *
 * Cobre, contra o banco descartável (container efêmero PG17):
 *   T1 atomicidade: o append acontece na MESMA transação da mutação de domínio
 *      (rollback do domínio não deixa evento órfão; falha do evento desfaz a
 *      mutação de domínio);
 *   T2 claim concorrente: dois workers com `FOR UPDATE SKIP LOCKED` dividem o
 *      lote sem processar o mesmo evento duas vezes;
 *   T3 idempotência do consumidor: o mesmo evento entregue 2× produz 1 efeito;
 *   T4 falha: `attempts++` com `available_at` futuro e retry limitado;
 *   T5 isolamento de tenant via RLS para a role `app_runtime`.
 *
 * Uso: `npx tsx scripts/db/test-outbox.ts` (DATABASE_ADMIN_URL local). O banco
 * descartável é migrado no início, então o script roda tanto isolado quanto
 * encadeado no fim de `db:test`.
 */

import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import {
  setDatabaseForTests,
  withTenantTransaction,
  type Database,
  type DatabaseIdentity,
} from "../../src/db/client.server";
import { bindTransactionContext, type RequestIdentity } from "../../src/lib/request-context";
import type { Executor } from "../../src/server/contracts/event.contracts";
import { ApplicationError } from "../../src/lib/api-error";
import {
  DrizzleOutboxRepository,
  outboxRepository,
} from "../../src/server/repositories/outbox.repository";
import { expenseRepository } from "../../src/server/repositories/expense.repository";
import { expenseService } from "../../src/server/services/expense.service";
import { OutboxWorker } from "../../src/server/services/outbox.worker";
import { ensureRuntimeRoleMembership, requireAdminUrl, runMigrations } from "./migrate";

const userA = "e1000000-0000-4000-8000-000000000001";
const tenantA = "e2000000-0000-4000-8000-000000000002";
const userB = "e3000000-0000-4000-8000-000000000003";
const tenantB = "e4000000-0000-4000-8000-000000000004";

const identityA: DatabaseIdentity = { userId: userA, tenantId: tenantA, roles: ["owner"] };
const identityB: DatabaseIdentity = { userId: userB, tenantId: tenantB, roles: ["owner"] };

// Nenhum caminho testado usa o sinal de cancelamento; um controller não abortado
// evita um timer pendente ao fim do script.
const requestA: RequestIdentity = {
  ...identityA,
  correlationId: "db-test-outbox-a",
  signal: new AbortController().signal,
};
const requestB: RequestIdentity = {
  ...identityB,
  correlationId: "db-test-outbox-b",
  signal: new AbortController().signal,
};

/** O Drizzle pode embrulhar o erro do driver; o SQLSTATE vive na cadeia de causas. */
function isPostgresError(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === code) return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

async function countRows(
  pool: Pool,
  sqlText: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const result = await pool.query<{ count: string }>(sqlText, [...params]);
  return Number(result.rows[0]?.count ?? "-1");
}

async function seedFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, 'Outbox A', 'outbox-a@example.test', true),
            ($2, 'Outbox B', 'outbox-b@example.test', true)
     on conflict (id) do nothing`,
    [userA, userB],
  );
  await pool.query(
    `insert into tenants (id, name, slug)
     values ($1, 'Outbox Tenant A', 'outbox-tenant-a'), ($2, 'Outbox Tenant B', 'outbox-tenant-b')
     on conflict (id) do nothing`,
    [tenantA, tenantB],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role)
     values ($1, $2, 'owner'), ($3, $4, 'owner')
     on conflict (tenant_id, user_id) do nothing`,
    [tenantA, userA, tenantB, userB],
  );
  await pool.query("delete from outbox_events where tenant_id in ($1, $2)", [tenantA, tenantB]);
  await pool.query("delete from expenses where tenant_id in ($1, $2)", [tenantA, tenantB]);
}

const expenseFixture = {
  category: null,
  amount: "10.0000",
  type: "fixa" as const,
  periodicity: "mensal",
  notes: null,
};

/** Enfileira um evento pela mesma porta do produtor de domínio. */
async function appendEvent(idempotencyKey: string, aggregateId: string): Promise<string> {
  const appended = await withTenantTransaction(identityA, (transaction) =>
    outboxRepository.append(bindTransactionContext(requestA, transaction), {
      eventType: "expense.saved",
      aggregateType: "expense",
      aggregateId,
      idempotencyKey,
      payload: { key: idempotencyKey },
      occurredAt: new Date(),
    }),
  );
  return appended.eventId;
}

interface EventState {
  status: string;
  attempts: number;
  lastError: string | null;
  /** `available_at` no futuro, medido pelo relógio do banco. */
  scheduledForLater: boolean;
  processedAt: Date | null;
}

async function readEventState(pool: Pool, eventId: string): Promise<EventState> {
  const result = await pool.query<EventState>(
    `select status,
            attempts,
            last_error as "lastError",
            available_at > now() as "scheduledForLater",
            processed_at as "processedAt"
     from outbox_events
     where id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`evento ${eventId} não encontrado`);
  return row;
}

/** Reentrega at-least-once: o evento volta para a fila como pendente. */
async function requeueEvent(pool: Pool, eventId: string): Promise<void> {
  const updated = await pool.query(
    "update outbox_events set status = 'pending', processed_at = null, available_at = now() where id = $1",
    [eventId],
  );
  if (updated.rowCount !== 1) throw new Error(`evento ${eventId} não reenfileirado`);
}

/**
 * T1 — o append usa a MESMA transação do domínio.
 *
 * (a) rollback depois da mutação não deixa evento órfão nem despesa;
 * (b) commit persiste os dois juntos;
 * (c) falha do append (CHECK de `event_type` vazio) desfaz a mutação de domínio.
 */
async function t1AtomicAppend(pool: Pool): Promise<void> {
  const before = await countRows(pool, "select count(*)::text as count from outbox_events");

  await assert.rejects(
    withTenantTransaction(identityA, async (transaction) => {
      const context = bindTransactionContext(requestA, transaction);
      const saved = await expenseService.save(context, {
        ...expenseFixture,
        name: "Despesa atômica",
      });
      assert.ok(saved.id, "a mutação de domínio deve produzir uma despesa");
      throw new Error("falha simulada após a mutação de domínio");
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("falha simulada após a mutação de domínio"),
    "a transação deve propagar a falha posterior à mutação",
  );

  assert.equal(
    await countRows(pool, "select count(*)::text as count from outbox_events"),
    before,
    "rollback do domínio não pode deixar evento órfão",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from expenses where tenant_id = $1", [
      tenantA,
    ]),
    0,
    "rollback do domínio não pode deixar despesa",
  );

  const committed = await withTenantTransaction(identityA, (transaction) =>
    expenseService.save(bindTransactionContext(requestA, transaction), {
      ...expenseFixture,
      name: "Despesa commitada",
      amount: "20.0000",
    }),
  );
  assert.ok(committed.id);

  const appended = await pool.query<{
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    idempotency_key: string;
    status: string;
    attempts: number;
    payload: Record<string, unknown>;
    processed_at: Date | null;
    last_error: string | null;
  }>(
    `select event_type, aggregate_type, aggregate_id, idempotency_key, status, attempts,
            payload, processed_at, last_error
     from outbox_events
     where tenant_id = $1 and aggregate_id = $2`,
    [tenantA, committed.id],
  );
  assert.equal(appended.rowCount, 1, "commit da despesa deve persistir exatamente um evento");
  const event = appended.rows[0];
  assert.equal(event?.event_type, "expense.saved");
  assert.equal(event?.aggregate_type, "expense");
  assert.equal(event?.idempotency_key, `expense.saved:${committed.id}:v${committed.version}`);
  assert.equal(event?.status, "pending");
  assert.equal(event?.attempts, 0);
  assert.equal(event?.processed_at, null);
  assert.equal(event?.last_error, null);
  assert.deepEqual(event?.payload, {
    expenseId: committed.id,
    name: "Despesa commitada",
    amount: "20.0000",
    type: "fixa",
    version: committed.version,
  });

  await assert.rejects(
    withTenantTransaction(identityA, async (transaction) => {
      const context = bindTransactionContext(requestA, transaction);
      await expenseRepository.save(context, {
        ...expenseFixture,
        name: "Despesa revertida",
        amount: "30.0000",
      });
      await outboxRepository.append(context, {
        eventType: "",
        aggregateType: "expense",
        aggregateId: "e7000000-0000-4000-8000-000000000007",
        idempotencyKey: "outbox-t1c",
        payload: {},
        occurredAt: new Date(),
      });
    }),
    (error: unknown) => isPostgresError(error, "23514"),
    "event_type vazio deve violar o CHECK e abortar a transação inteira",
  );

  assert.equal(
    await countRows(pool, "select count(*)::text as count from expenses where name = $1", [
      "Despesa revertida",
    ]),
    0,
    "falha do append deve desfazer a mutação de domínio na mesma transação",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from outbox_events"),
    before + 1,
    "o append rejeitado não pode persistir evento",
  );

  console.log(
    "T1 atomicidade: rollback do domínio sem evento órfão + falha do evento sem despesa: OK",
  );
}

/**
 * T5 — isolamento de tenant: sob a role `app_runtime` (NOSUPERUSER/NOBYPASSRLS)
 * o evento de A é invisível para B e um append cruzado é recusado pela policy.
 */
async function t5TenantIsolation(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  const eventA = await withTenantTransaction(identityA, (transaction) =>
    outboxRepository.append(bindTransactionContext(requestA, transaction), {
      eventType: "expense.saved",
      aggregateType: "expense",
      aggregateId: "e8000000-0000-4000-8000-000000000008",
      idempotencyKey: "t5:a",
      payload: { tenant: "a" },
      occurredAt: new Date(),
    }),
  );
  const eventB = await withTenantTransaction(identityB, (transaction) =>
    outboxRepository.append(bindTransactionContext(requestB, transaction), {
      eventType: "expense.saved",
      aggregateType: "expense",
      aggregateId: "e9000000-0000-4000-8000-000000000009",
      idempotencyKey: "t5:b",
      payload: { tenant: "b" },
      occurredAt: new Date(),
    }),
  );
  assert.notEqual(eventA.eventId, eventB.eventId);

  const metadata = await pool.query<{
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
    publicInsert: boolean;
  }>(
    `select c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', 'public.outbox_events', 'select') as "select",
            has_table_privilege('app_runtime', 'public.outbox_events', 'insert') as "insert",
            has_table_privilege('app_runtime', 'public.outbox_events', 'update') as "update",
            has_table_privilege('app_runtime', 'public.outbox_events', 'delete') as "delete",
            has_table_privilege('public', 'public.outbox_events', 'insert') as "publicInsert"
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'outbox_events'`,
  );
  assert.deepEqual(
    metadata.rows[0],
    {
      rowSecurity: true,
      select: true,
      insert: true,
      update: true,
      delete: false,
      publicInsert: false,
    },
    "outbox_events deve ter RLS habilitado e grants SELECT/INSERT/UPDATE somente para app_runtime",
  );

  const consumptionMetadata = await pool.query<{
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
  }>(
    `select c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', 'public.outbox_consumptions', 'select') as "select",
            has_table_privilege('app_runtime', 'public.outbox_consumptions', 'insert') as "insert",
            has_table_privilege('app_runtime', 'public.outbox_consumptions', 'update') as "update",
            has_table_privilege('app_runtime', 'public.outbox_consumptions', 'delete') as "delete"
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'outbox_consumptions'`,
  );
  assert.deepEqual(
    consumptionMetadata.rows[0],
    { rowSecurity: true, select: true, insert: true, update: false, delete: false },
    "outbox_consumptions deve ser append-only (SELECT/INSERT) para app_runtime",
  );

  const runtimeRole = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "select rolsuper, rolbypassrls from pg_roles where rolname = 'app_runtime'",
  );
  assert.deepEqual(
    runtimeRole.rows[0],
    { rolsuper: false, rolbypassrls: false },
    "app_runtime deve ser NOSUPERUSER e NOBYPASSRLS",
  );

  const client = await pool.connect();
  const runtimeDatabase = drizzle({ client, schema });
  try {
    await runtimeDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(sql`select set_config('app.current_user_id', ${userA}, true)`);
      await transaction.execute(sql`select set_config('app.current_tenant_id', ${tenantA}, true)`);
      // SAFETY: o driver node-postgres e o neon expõem a mesma superfície de
      // transação consumida pelo repositório (mesma justificativa do cast em
      // `src/db/client.server.ts`).
      const executor = transaction as unknown as Executor;

      const own = await transaction
        .select({ count: sql<string>`count(*)::text` })
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, eventA.eventId));
      assert.equal(own[0]?.count, "1", "A deve enxergar o próprio evento");

      const foreign = await transaction
        .select({ count: sql<string>`count(*)::text` })
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, eventB.eventId));
      assert.equal(foreign[0]?.count, "0", "o evento de B deve ser invisível para A");

      const claimable = await outboxRepository.claimPending(
        bindTransactionContext(requestA, executor),
        { batchSize: 10, maxAttempts: 5 },
      );
      assert.deepEqual(
        claimable.map((claimed) => claimed.id),
        [eventA.eventId],
        "o claim sob app_runtime deve devolver somente o evento do tenant do GUC",
      );

      await assert.rejects(
        outboxRepository.append(bindTransactionContext(requestB, executor), {
          eventType: "expense.saved",
          aggregateType: "expense",
          aggregateId: "ea000000-0000-4000-8000-00000000000a",
          idempotencyKey: "t5:cross",
          payload: {},
          occurredAt: new Date(),
        }),
        (error: unknown) => isPostgresError(error, "42501"),
        "append com tenant_id alheio ao GUC deve ser recusado pela policy (WITH CHECK)",
      );

      await transaction.execute(sql`rollback`);
    });
  } finally {
    client.release();
  }

  console.log("T5 isolamento: RLS por tenant sob app_runtime + WITH CHECK do append cruzado: OK");
}

/**
 * T2 — claim concorrente: o primeiro worker fica bloqueado dentro do handler
 * (com as linhas reclamadas travadas) enquanto o segundo reivindica o resto;
 * `SKIP LOCKED` garante lotes disjuntos e nenhum evento processado 2×.
 */
async function t2ConcurrentClaim(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  const eventIds: string[] = [];
  for (const index of [1, 2, 3, 4]) {
    eventIds.push(await appendEvent(`t2:${index}`, `eb000000-0000-4000-8000-00000000000${index}`));
  }

  const effects = new Map<string, number>();
  const handledBy = new Map<string, Set<string>>();
  for (const id of eventIds) handledBy.set(id, new Set());

  let releaseFirstBatch = () => {};
  const firstBatchGate = new Promise<void>((resolve) => {
    releaseFirstBatch = resolve;
  });
  let signalFirstHandler = () => {};
  const firstHandlerStarted = new Promise<void>((resolve) => {
    signalFirstHandler = resolve;
  });

  const handlerFor =
    (workerName: string, blockOnFirstEvent: boolean) =>
    async (event: { id: string }): Promise<void> => {
      effects.set(event.id, (effects.get(event.id) ?? 0) + 1);
      handledBy.get(event.id)?.add(workerName);
      if (blockOnFirstEvent) {
        signalFirstHandler();
        await firstBatchGate;
      }
    };

  const workerOne = new OutboxWorker(handlerFor("worker-1", true), {
    batchSize: 2,
    maxAttempts: 5,
    consumerName: "consumer-1",
  });
  const workerTwo = new OutboxWorker(handlerFor("worker-2", false), {
    batchSize: 2,
    maxAttempts: 5,
    consumerName: "consumer-2",
  });

  const first = workerOne.runOnce(identityA);
  await firstHandlerStarted;
  // O segundo claim tem de terminar com as linhas do primeiro ainda travadas:
  // é isso que prova o `SKIP LOCKED` (sem ele a query espera o lock e só segue
  // depois do commit do primeiro worker).
  const secondOutcome = await Promise.race([
    workerTwo.runOnce(identityA).then((result) => ({ kind: "settled" as const, result })),
    new Promise<{ kind: "blocked" }>((resolve) => {
      // `unref`: no caminho verde o timer pendente não pode segurar o processo.
      setTimeout(() => resolve({ kind: "blocked" }), 5_000).unref();
    }),
  ]);
  // Libera o primeiro worker em qualquer caminho, para a transação dele fechar
  // mesmo quando a asserção abaixo falha.
  releaseFirstBatch();
  const firstResult = await first;
  assert.equal(
    secondOutcome.kind,
    "settled",
    "o segundo claim não pode bloquear nas linhas travadas pelo primeiro worker",
  );
  if (secondOutcome.kind !== "settled") return;
  const second = secondOutcome.result;

  assert.equal(firstResult.claimed, 2, "o primeiro worker deve reclamar o lote cheio");
  assert.equal(firstResult.processed, 2);
  assert.equal(
    second.claimed,
    2,
    "com 2 linhas travadas pelo primeiro worker, o segundo só pode reclamar as outras 2",
  );
  assert.equal(second.processed, 2);

  assert.equal(effects.size, 4, "todos os eventos devem ser processados");
  for (const [eventId, count] of effects) {
    assert.equal(count, 1, `evento ${eventId} não pode ser processado 2×`);
    assert.equal(handledBy.get(eventId)?.size, 1, `evento ${eventId} não pode ir a dois workers`);
  }

  const processed = await countRows(
    pool,
    "select count(*)::text as count from outbox_events where tenant_id = $1 and status = 'processed'",
    [tenantA],
  );
  assert.equal(processed, 4, "os 4 eventos devem ficar processed");
  const doubleConsumed = await countRows(
    pool,
    `select count(*)::text as count from (
       select event_id from outbox_consumptions group by event_id having count(*) > 1
     ) duplicated`,
  );
  assert.equal(doubleConsumed, 0, "nenhum evento pode ter duas linhas de inbox");

  for (const [handledEventId, workers] of handledBy) {
    console.log(
      `  ${handledEventId} → worker=${[...workers].join("|")} · efeitos=${effects.get(handledEventId)}`,
    );
  }
  const inbox = await pool.query<{ consumer_name: string; event_id: string }>(
    `select consumer_name, event_id
       from outbox_consumptions
      where event_id = any($1::uuid[])
      order by event_id, consumer_name`,
    [eventIds],
  );
  assert.equal(inbox.rowCount, 4, "cada evento deve ter exatamente uma linha de inbox");
  for (const row of inbox.rows) {
    console.log(`  inbox: ${row.event_id} ← ${row.consumer_name}`);
  }
  console.log("T2 claim concorrente: 2 workers com SKIP LOCKED dividem o lote sem repetir: OK");
}

/**
 * T3 — idempotência do consumidor: o mesmo evento entregue 2× (inclusive por
 * outra instância do worker, com a inbox persistida) produz 1 efeito.
 */
async function t3ConsumerIdempotency(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  const effects = new Map<string, number>();
  const handler = async (event: { id: string }): Promise<void> => {
    effects.set(event.id, (effects.get(event.id) ?? 0) + 1);
  };
  const consumerName = "consumer-idempotent";
  const worker = new OutboxWorker(handler, { batchSize: 5, maxAttempts: 5, consumerName });
  const eventId = await appendEvent("t3:1", "ec000000-0000-4000-8000-00000000000c");

  const first = await worker.runOnce(identityA);
  assert.equal(first.processed, 1);
  assert.equal(first.duplicates, 0);
  assert.equal(effects.get(eventId), 1, "a primeira entrega deve aplicar o efeito");

  await requeueEvent(pool, eventId);
  const redelivered = await worker.runOnce(identityA);
  assert.equal(redelivered.claimed, 1, "a reentrega volta a ser reclamada");
  assert.equal(redelivered.duplicates, 1);
  assert.equal(redelivered.processed, 0);
  assert.equal(effects.get(eventId), 1, "a reentrega não pode duplicar o efeito");

  await requeueEvent(pool, eventId);
  const replica = new OutboxWorker(handler, { batchSize: 5, maxAttempts: 5, consumerName });
  const byReplica = await replica.runOnce(identityA);
  assert.equal(byReplica.duplicates, 1, "a inbox é persistida, não memória do worker");
  assert.equal(effects.get(eventId), 1);

  const finalState = await readEventState(pool, eventId);
  assert.equal(finalState.status, "processed", "a reentrega já consumida segue processed");

  // A chave de idempotência é (consumer, event): outro consumidor ainda não viu
  // este evento e deve aplicar o próprio efeito.
  await requeueEvent(pool, eventId);
  const otherEffects = new Map<string, number>();
  const otherConsumer = new OutboxWorker(
    async (event: { id: string }): Promise<void> => {
      otherEffects.set(event.id, (otherEffects.get(event.id) ?? 0) + 1);
    },
    { batchSize: 5, maxAttempts: 5, consumerName: "consumer-other" },
  );
  const byOtherConsumer = await otherConsumer.runOnce(identityA);
  assert.equal(byOtherConsumer.processed, 1);
  assert.equal(otherEffects.get(eventId), 1, "consumidor distinto tem o próprio efeito");
  assert.equal(effects.get(eventId), 1, "o consumidor original não é afetado");

  // Superfície do contrato M-04: `publishPending` drena pelo dispatcher
  // injetado e falha alto quando a composição esqueceu de injetá-lo.
  const contractEventId = await appendEvent("t3:contract", "ef000000-0000-4000-8000-00000000000f");
  await withTenantTransaction(identityA, async (transaction) => {
    const context = bindTransactionContext(requestA, transaction);
    await assert.rejects(
      new DrizzleOutboxRepository().publishPending(context),
      (error: unknown) => error instanceof ApplicationError && error.code === "DEPENDENCY_ERROR",
      "sem dispatcher o contrato não pode fingir que publicou",
    );
    const published = await new DrizzleOutboxRepository(
      new OutboxWorker(handler, {
        batchSize: 5,
        maxAttempts: 5,
        consumerName: "consumer-contract",
      }),
    ).publishPending(context);
    assert.equal(published, 1, "o contrato devolve quantos eventos foram publicados");
  });
  const contractState = await readEventState(pool, contractEventId);
  assert.equal(contractState.status, "processed");

  console.log(
    `  ${eventId} → efeito ${consumerName}=${effects.get(eventId)} após 3 entregas · consumer-other=${otherEffects.get(eventId)}`,
  );
  console.log("T3 idempotência: mesmo evento 2× ⇒ 1 efeito (inbox persistida por consumidor): OK");
}

/**
 * T4 — falha: `attempts++`, `last_error` e `available_at` futuro; a tentativa
 * seguinte só acontece depois do backoff e o evento para de ser reclamado ao
 * esgotar `maxAttempts` (sem retry infinito). O efeito reprocessado prova que o
 * registro da inbox reverteu junto com o savepoint do handler.
 */
async function t4FailureBackoff(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  let handlerRuns = 0;
  const worker = new OutboxWorker(
    async (): Promise<void> => {
      handlerRuns += 1;
      throw new Error("falha do consumidor");
    },
    {
      batchSize: 5,
      maxAttempts: 2,
      consumerName: "consumer-failing",
      backoffMs: () => 60_000,
    },
  );
  const eventId = await appendEvent("t4:1", "ed000000-0000-4000-8000-00000000000d");

  const first = await worker.runOnce(identityA);
  assert.equal(first.claimed, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.processed, 0);
  const afterFirstFailure = await readEventState(pool, eventId);
  assert.equal(afterFirstFailure.status, "failed");
  assert.equal(afterFirstFailure.attempts, 1, "a falha consome uma tentativa");
  assert.equal(afterFirstFailure.lastError, "falha do consumidor");
  assert.equal(afterFirstFailure.scheduledForLater, true, "o backoff agenda o futuro");
  assert.equal(afterFirstFailure.processedAt, null);
  assert.equal(handlerRuns, 1);

  const duringBackoff = await worker.runOnce(identityA);
  assert.equal(duringBackoff.claimed, 0, "dentro do backoff o evento não é reclamado");
  assert.equal(handlerRuns, 1);

  await requeueEvent(pool, eventId);
  const second = await worker.runOnce(identityA);
  assert.equal(second.claimed, 1);
  assert.equal(second.failed, 1);
  assert.equal(handlerRuns, 2, "a tentativa após o backoff reexecuta o handler");
  const afterSecondFailure = await readEventState(pool, eventId);
  assert.equal(afterSecondFailure.attempts, 2);
  assert.equal(afterSecondFailure.status, "failed");

  // Vencido de novo (status `failed` preservado): o predicado do claim exige
  // `attempts < maxAttempts`, então o evento esgotado não volta para a fila.
  await pool.query("update outbox_events set available_at = now() where id = $1", [eventId]);
  const exhausted = await worker.runOnce(identityA);
  assert.equal(exhausted.claimed, 0, "attempts esgotado não volta para a fila");
  assert.equal(handlerRuns, 2, "sem retry infinito");
  const exhaustedState = await readEventState(pool, eventId);
  assert.equal(exhaustedState.status, "failed");
  assert.equal(exhaustedState.attempts, 2);
  assert.equal(exhaustedState.lastError, "falha do consumidor", "o diagnóstico é preservado");

  // Política padrão de backoff (sem override): exponencial a partir de 1s — a
  // falha nunca agenda o próprio instante (retry storm). `maxAttempts: 2` só
  // isola o caso de t4:1, que já está esgotado.
  const defaultBackoffWorker = new OutboxWorker(
    async (): Promise<void> => {
      throw new Error("falha padrão");
    },
    { consumerName: "consumer-default-backoff", maxAttempts: 2 },
  );
  const defaultBackoffEventId = await appendEvent("t4:2", "ee000000-0000-4000-8000-00000000000e");
  const defaultFailure = await defaultBackoffWorker.runOnce(identityA);
  assert.equal(defaultFailure.claimed, 1);
  assert.equal(defaultFailure.failed, 1);
  const defaultBackoffState = await readEventState(pool, defaultBackoffEventId);
  assert.equal(defaultBackoffState.attempts, 1);
  assert.equal(defaultBackoffState.scheduledForLater, true, "o backoff padrão agenda o futuro");
  assert.equal(defaultBackoffState.lastError, "falha padrão");

  console.log("T4 falha: attempts++ + available_at futuro + retry limitado por maxAttempts: OK");
}

async function main(): Promise<void> {
  const adminUrl = requireAdminUrl();
  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const database = drizzle({ client: pool, schema });
  setDatabaseForTests(database as unknown as Database);

  try {
    await runMigrations(adminUrl);
    await ensureRuntimeRoleMembership(pool);
    await seedFixtures(pool);
    await t1AtomicAppend(pool);
    await t2ConcurrentClaim(pool);
    await t3ConsumerIdempotency(pool);
    await t4FailureBackoff(pool);
    await t5TenantIsolation(pool);
  } finally {
    setDatabaseForTests(undefined);
    await pool.end();
  }

  console.log("Outbox §23 (23.1 + 23.2): atomicidade, claim concorrente, idempotência: OK");
}

await main();
