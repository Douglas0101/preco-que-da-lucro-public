/**
 * §43/§15.2/§15.4/§15.6 — memória persistente (MEM-D2/D3/D4 — degraus D2, D3 e D4).
 *
 * Cobre, contra o banco descartável (container efêmero PG17, `127.0.0.1`):
 *   T1 (a) isolamento de tenant: append com identidade A é invisível para B
 *      (0 linhas sob `app_runtime` com o GUC de B) e o append forjando o
 *      `tenant_id` de B é recusado pelo `WITH CHECK` da policy (42501), sem
 *      deixar linha;
 *   T2 (b) proveniência: `search` devolve a proveniência gravada, proveniência
 *      órfã é impossível (FK composta + CHECK de origem) e as CHECKs de
 *      conteúdo/faixa recusam valores inválidos;
 *   T3 (c) atomicidade: memória e efeito de domínio na MESMA transação — o
 *      rollback de um não deixa o outro, nas duas direções;
 *   T4 (d) delete: afeta só a linha do tenant corrente, devolve `false` para id
 *      inexistente (e para id de outro tenant) e cai em cascata na fonte;
 *   T5 (e) `check-migration-classes` verde com a tag nova classificada `SAFE`.
 *
 * D3 (§15.6 — dedup + versionamento + conflitos), com controle positivo e
 * negativo em cada caso:
 *   D3/T1 dedup idempotente: 2ª gravação idêntica (inclusive com outra forma de
 *      espaço/Unicode/invisível `Cf`) não cria linha, devolve a existente com
 *      `duplicated:true` e a contagem de memória/fonte/versão não muda; caixa
 *      **não** é normalizada (memória nova);
 *   D3/T2 revisão: arquiva o estado substituído em `ai_memory_versions` com
 *      `version` incremental e a versão anterior fica **byte a byte** igual
 *      (`content`/`dedup_key`/`created_at` lidos do banco); revisão sem
 *      alteração falha alto;
 *   D3/T3 conflito: registra em `ai_memory_conflicts`, deixa a memória ativa
 *      byte a byte inalterada e o `search` continua devolvendo só o ativo;
 *   D3/T4 delete × expurgo: recusa (`false`, sem apagar nada) memória com
 *      histórico e o expurgo apaga versões+conflitos+fontes+memória na MESMA
 *      transação (rollback depois do expurgo devolve tudo);
 *   D3/T5 concorrência: duas sessões reais (2 conexões) gravando o mesmo
 *      conteúdo ⇒ exatamente 1 linha ativa, decidida pelo índice único parcial;
 *   D3/T6 isolamento de tenant do dedup: o mesmo conteúdo em dois tenants são 2
 *      linhas e B não vê a de A; o discriminador da conversa não colapsa duas
 *      conversas do mesmo tenant;
 *   D3/T7 imutabilidade por privilégio: `app_runtime` **consegue** `INSERT` e
 *      **não** consegue `UPDATE`/`DELETE` em `ai_memory_versions` (42501), com os
 *      metadados de RLS/grants das duas tabelas novas;
 *   D3/T8 classificação: a migration nova está `SAFE`/`appliedOn: empty` no
 *      registry §27a e tem down;
 *   D3/T9 revisão × colisão de chave: revisar para um conteúdo que JÁ é o head
 *      ativo de outra memória do tenant vira `ApplicationError`/CONFLICT (não o
 *      23505 cru do driver, que viraria 500) e a transação faz rollback sem
 *      rastro — nem a versão arquivada pelo `revise` fica.
 *
 * D4 (§43 — delete/export + access log + TTL por camada, H-12 aprovado):
 *   D4/T1 export do tenant A = exatamente o conjunto de A (fontes + versões) e
 *      nada de B, recortes por camada/escopo, auditoria do export e
 *      `AUTHORIZATION_ERROR` para identidade sem `has_tenant_access` (nunca
 *      pacote vazio);
 *   D4/T2 auditoria do delete: `allowed`/`refused`/`not_found` por chamada com
 *      alvo, autor e linhas afetadas; recusa de memória pessoal de outro autor
 *      para membro e allow para owner (controle positivo) e para o escopo do
 *      tenant; trilha tenant-scoped e sem conteúdo;
 *   D4/T3 TTL por camada: janela vinda da policy versionada (L1/L2/L3 com TTL,
 *      L4/L5 sem), republicação de policy mudando a janela das gravações
 *      seguintes, expiração idempotente e tenant-scoped, retrieval sem vencida
 *      e falha alta quando a camada não tem policy (INV-013);
 *   D4/T4 migration reproduzível: cadeia 0000→0019 do zero e up→down→up da 0019
 *      COM DADO (conteúdo preservado, colunas re-adicionadas com default,
 *      políticas re-semeadas);
 *   D4/T5 classificação da 0019 (ONLINE_WITH_CARE + idempotent + onlineCare +
 *      sha256 byte a byte + down);
 *   D4/T6 privilégios: trilha append-only medida sob `app_runtime` (42501 em
 *      UPDATE/DELETE), `WITH CHECK` contra linha forjada, CHECKs de vocabulário,
 *      políticas globais com SELECT/INSERT e sem RLS.
 *
 * As denegações são provadas **no banco**: o admin do container é superuser e
 * bypassa RLS, então os negativos rodam sob `set local role app_runtime`
 * (NOSUPERUSER/NOBYPASSRLS) com as GUCs de tenant — mesma técnica de
 * `scripts/db/test-outbox.ts` (T5). Nada aqui depende de filtro de aplicação.
 *
 * Uso: `npx tsx scripts/db/test-memory.ts` (DATABASE_ADMIN_URL local). O banco
 * descartável é migrado no início, então o script roda tanto isolado quanto
 * encadeado no fim de `db:test`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "../../src/db/schema";
import {
  setDatabaseForTests,
  withTenantTransaction,
  type Database,
  type DatabaseIdentity,
  type DatabaseTransaction,
} from "../../src/db/client.server";
import { bindTransactionContext, type RequestIdentity } from "../../src/lib/request-context";
import { ApplicationError } from "../../src/lib/api-error";
import type { MemoryRecordInput } from "../../src/server/contracts/memory.contracts";
import { memoryRepository } from "../../src/server/repositories/memory.repository";
import { expenseRepository } from "../../src/server/repositories/expense.repository";
import { classifyProject, computeSha256 } from "./check-migration-classes";
import { ensureRuntimeRoleMembership, requireAdminUrl, runMigrations } from "./migrate";
import { migrationClasses } from "./migration-classes";

const userA = "c1000000-0000-4000-8000-000000000001";
const tenantA = "c2000000-0000-4000-8000-000000000002";
const userB = "c3000000-0000-4000-8000-000000000003";
const tenantB = "c4000000-0000-4000-8000-000000000004";
const userC = "ca000000-0000-4000-8000-00000000000a";
const conversationA = "c5000000-0000-4000-8000-000000000005";
const conversationB = "c6000000-0000-4000-8000-000000000006";

/** Tag da migration de memória (a entrada nova do registry §27a). */
const MEMORY_MIGRATION_TAG = "0017_past_gideon";
const MEMORY_MIGRATION_DOWN = "0017_to_0016_down.sql";

/** Tag do degrau D3 (dedup/versões/conflitos) e seu down. */
const MEMORY_D3_MIGRATION_TAG = "0018_polite_living_tribunal";
const MEMORY_D3_MIGRATION_DOWN = "0018_to_0017_down.sql";

/** Tag do degrau D4 (delete/export + access log + TTL por camada) e seu down. */
const MEMORY_D4_MIGRATION_TAG = "0019_tiresome_robin_chapel";
const MEMORY_D4_MIGRATION_DOWN = "0019_to_0018_down.sql";
/** A cadeia completa do journal (0000…0019) aplicada do zero. */
const EXPECTED_JOURNAL_COUNT = "20";

/** Segunda conversa do tenant A: prova que o discriminador da chave separa duas
 * conversas com o mesmo conteúdo (senão uma sumiria como "duplicata"). O índice
 * `chat_conversations_tenant_user_uidx` só permite uma conversa por (tenant,
 * usuário), então a segunda conversa é de outro membro do MESMO tenant. */
const conversationA2 = "c9000000-0000-4000-8000-000000000009";

const identityA: DatabaseIdentity = { userId: userA, tenantId: tenantA, roles: ["owner"] };
const identityB: DatabaseIdentity = { userId: userB, tenantId: tenantB, roles: ["owner"] };

// Nenhum caminho testado usa o sinal de cancelamento; um controller não abortado
// evita um timer pendente ao fim do script.
const requestA: RequestIdentity = {
  ...identityA,
  correlationId: "db-test-memory-a",
  signal: new AbortController().signal,
};
const requestB: RequestIdentity = {
  ...identityB,
  correlationId: "db-test-memory-b",
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

function memoryInput(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    scope: "tenant",
    content: "Preferência: relatórios semanais com margem por produto",
    importance: 0.6,
    provenance: {
      sourceKind: "user",
      sourceId: "chat-message-42",
      capturedAt: new Date("2026-09-16T12:00:00.000Z"),
      inferred: false,
      confidence: 0.9,
    },
    ...overrides,
  };
}

const expenseFixture = {
  category: null,
  amount: "10.0000",
  type: "fixa" as const,
  periodicity: "mensal",
  notes: null,
};

/** Limpa as linhas de memória dos dois tenants (o script é reexecutável e roda
 * encadeado no `db:test`, onde o banco já tem as tabelas). O histórico e os
 * conflitos caem antes da memória: as FKs do D3 são `ON DELETE RESTRICT`. */
async function resetMemory(pool: Pool): Promise<void> {
  await pool.query("delete from ai_memory_access_log where tenant_id in ($1, $2)", [
    tenantA,
    tenantB,
  ]);
  await pool.query("delete from ai_memory_conflicts where tenant_id in ($1, $2)", [
    tenantA,
    tenantB,
  ]);
  await pool.query("delete from ai_memory_versions where tenant_id in ($1, $2)", [
    tenantA,
    tenantB,
  ]);
  await pool.query("delete from ai_memory_sources where tenant_id in ($1, $2)", [tenantA, tenantB]);
  await pool.query("delete from ai_memories where tenant_id in ($1, $2)", [tenantA, tenantB]);
}

async function seedFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, 'Memória A', 'memory-a@example.test', true),
            ($2, 'Memória B', 'memory-b@example.test', true)
     on conflict (id) do nothing`,
    [userA, userB],
  );
  await pool.query(
    `insert into tenants (id, name, slug)
     values ($1, 'Memória Tenant A', 'memory-tenant-a'),
            ($2, 'Memória Tenant B', 'memory-tenant-b')
     on conflict (id) do nothing`,
    [tenantA, tenantB],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role)
     values ($1, $2, 'owner'), ($3, $4, 'owner')
     on conflict (tenant_id, user_id) do nothing`,
    [tenantA, userA, tenantB, userB],
  );
  await pool.query(
    `insert into chat_conversations (id, tenant_id, user_id)
     values ($1, $2, $3), ($4, $5, $6)
     on conflict (id) do nothing`,
    [conversationA, tenantA, userA, conversationB, tenantB, userB],
  );
  await resetMemory(pool);
}

/**
 * Executa `operation` como `app_runtime` (NOSUPERUSER/NOBYPASSRLS) com as GUCs
 * de tenant da identidade. É a única forma de provar denegação **no banco**:
 * o admin do container é superuser e bypassaria a policy.
 */
async function withRuntimeRoleTransaction<T>(
  pool: Pool,
  identity: DatabaseIdentity,
  operation: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const database = drizzle({ client, schema });
    return await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(
        sql`select set_config('app.current_user_id', ${identity.userId}, true)`,
      );
      await transaction.execute(
        sql`select set_config('app.current_tenant_id', ${identity.tenantId}, true)`,
      );
      await transaction.execute(
        sql`select set_config('app.current_roles', ${identity.roles.join(",")}, true)`,
      );
      return operation(transaction);
    });
  } finally {
    client.release();
  }
}

/** Conta linhas enxergadas pela role de runtime com o GUC de `identity`. */
function runtimeCount(pool: Pool, identity: DatabaseIdentity, table: string): Promise<number> {
  return withRuntimeRoleTransaction(pool, identity, async (transaction) => {
    const result = await transaction.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.identifier(table)}`,
    );
    return Number(result.rows[0]?.count ?? "-1");
  });
}

/** Espera a denegação do banco (SQLSTATE) sob a role de runtime. */
async function expectRuntimeDenial(
  pool: Pool,
  identity: DatabaseIdentity,
  code: string,
  operation: (transaction: DatabaseTransaction) => Promise<unknown>,
  message: string,
): Promise<void> {
  await assert.rejects(
    withRuntimeRoleTransaction(pool, identity, operation),
    (error: unknown) => isPostgresError(error, code),
    message,
  );
}

/**
 * T1 (a) — isolamento de tenant.
 *
 * A memória de A não é visível para B (contagem sob `app_runtime` com o GUC de
 * B = 0; com o GUC de A = 1, então a medição não é vacuosa) e a inserção com
 * `tenant_id` de B sob o GUC de A viola o `WITH CHECK` da policy (42501).
 */
async function t1TenantIsolation(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const { record: appended, duplicated: firstAppendDuplicated } = await withTenantTransaction(
    identityA,
    (transaction) =>
      memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  assert.equal(
    firstAppendDuplicated,
    false,
    "a primeira gravação não é duplicata (o sinal só é true para a existente)",
  );
  assert.ok(appended.id, "o append de A deve devolver a memória gravada");
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_sources where memory_id = $1",
      [appended.id],
    ),
    1,
    "o append com proveniência deve gravar exatamente uma fonte",
  );

  const searchedByB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestB, transaction), {
      text: "relatórios semanais",
    }),
  );
  assert.deepEqual(searchedByB, [], "a busca com identidade B não pode devolver memória de A");

  assert.equal(
    await runtimeCount(pool, identityB, "ai_memories"),
    0,
    "sob app_runtime com o GUC de B a tabela de memória deve estar vazia (RLS, não filtro de app)",
  );
  assert.equal(
    await runtimeCount(pool, identityA, "ai_memories"),
    1,
    "sob app_runtime com o GUC de A a memória precisa aparecer (senão a contagem acima seria vacuosa)",
  );
  assert.equal(await runtimeCount(pool, identityB, "ai_memory_sources"), 0);
  assert.equal(await runtimeCount(pool, identityA, "ai_memory_sources"), 1);

  await expectRuntimeDenial(
    pool,
    identityA,
    "42501",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memories (tenant_id, user_id, scope, content, dedup_key)
            values (${tenantB}, ${userA}, 'tenant', 'memória forjada do tenant B', 'forged-tenant-key')`,
      ),
    "append forjando o tenant_id de B sob o GUC de A deve violar o WITH CHECK (42501)",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where tenant_id = $1", [
      tenantB,
    ]),
    0,
    "a inserção recusada pela policy não pode deixar linha",
  );

  await expectRuntimeDenial(
    pool,
    identityA,
    "23503",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memories (tenant_id, user_id, scope, content, dedup_key)
            values (${tenantA}, ${userB}, 'tenant', 'memória de membro de outro tenant', 'non-member-key')`,
      ),
    "memória atribuída a quem não é membro do tenant deve violar a FK composta para tenant_memberships",
  );

  console.log(
    "T1 isolamento: busca de B = 0 linhas sob RLS + append forjado recusado por WITH CHECK (42501): OK",
  );
}

/**
 * T2 (b) — proveniência: `search` devolve a fonte gravada; fonte órfã (memória
 * inexistente, memória de outro tenant, conversa de outro tenant) e fonte sem
 * nenhuma origem são impossíveis; as CHECKs de conteúdo e de faixa mordem.
 */
async function t2Provenance(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const capturedAt = new Date("2026-09-16T12:00:00.000Z");
  const { record, duplicated } = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({
        scope: "conversation",
        content: "Prefere relatórios semanais por produto",
        importance: 0.7,
        provenance: {
          sourceKind: "user",
          sourceId: "chat-message-42",
          conversationId: conversationA,
          capturedAt,
          inferred: false,
          confidence: 0.9,
        },
      }),
    ),
  );
  assert.deepEqual(
    record.provenance,
    {
      sourceKind: "user",
      sourceId: "chat-message-42",
      conversationId: conversationA,
      capturedAt,
      inferred: false,
      confidence: 0.9,
    },
    "o append deve devolver a proveniência gravada",
  );
  assert.equal(duplicated, false, "a memória inédita não é duplicata");
  assert.equal(record.status, "active");
  assert.equal(record.importance, 0.7);

  const found = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestA, transaction), {
      text: "relatórios semanais",
    }),
  );
  assert.equal(found.length, 1, "a busca do próprio tenant deve devolver a memória");
  assert.deepEqual(
    found[0]?.provenance,
    record.provenance,
    "a busca deve devolver a proveniência junto do registro",
  );

  // Duas fontes para a mesma memória: o read model expõe a mais antiga
  // (`captured_at` asc, `id` asc) — regra determinística, não ordem de inserção.
  await pool.query(
    `insert into ai_memory_sources
       (tenant_id, memory_id, source_kind, source_ref, confidence, captured_at)
     values ($1, $2, 'model', 'model:later', 0.4, $3)`,
    [tenantA, record.id, new Date("2026-09-16T15:00:00.000Z")],
  );
  const withTwoSources = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestA, transaction), {
      text: "relatórios semanais",
    }),
  );
  assert.equal(
    withTwoSources[0]?.provenance?.sourceId,
    "chat-message-42",
    "com duas fontes o read model expõe a mais antiga",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_sources where memory_id = $1",
      [record.id],
    ),
    2,
    "as duas fontes coexistem (a proveniência é 1:N)",
  );

  // Origem opcional de verdade: só o rótulo opaco é aceito; as FKs tipadas são
  // ausentes e a linha passa (o CHECK exige ao menos uma origem).
  await assert.doesNotReject(
    pool.query(
      `insert into ai_memory_sources
         (tenant_id, memory_id, source_kind, source_ref, confidence, captured_at, inferred)
       values ($1, $2, 'tool', 'tool:run-1', 0.5, now(), true)`,
      [tenantA, record.id],
    ),
    "fonte sem FK tipada é válida desde que tenha ao menos uma origem",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memory_sources
         (tenant_id, memory_id, source_kind, source_ref, confidence, captured_at)
       values ($1, $2, 'user', 'user:orphan', 0.5, now())`,
      [tenantA, "c7000000-0000-4000-8000-000000000007"],
    ),
    (error: unknown) => isPostgresError(error, "23503"),
    "fonte apontando para memória inexistente deve violar a FK composta",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memory_sources
         (tenant_id, memory_id, source_kind, source_ref, confidence, captured_at)
       values ($1, $2, 'user', 'user:cross-tenant', 0.5, now())`,
      [tenantB, record.id],
    ),
    (error: unknown) => isPostgresError(error, "23503"),
    "fonte de B apontando para memória de A deve violar a FK composta (tenant_id, memory_id)",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memory_sources
         (tenant_id, memory_id, source_kind, source_ref, conversation_id, confidence, captured_at)
       values ($1, $2, 'user', 'user:foreign-conversation', $3, 0.5, now())`,
      [tenantA, record.id, conversationB],
    ),
    (error: unknown) => isPostgresError(error, "23503"),
    "conversa de outro tenant na proveniência deve violar a FK composta (tenant_id, conversation_id)",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memory_sources
         (tenant_id, memory_id, source_kind, confidence, captured_at)
       values ($1, $2, 'user', 0.5, now())`,
      [tenantA, record.id],
    ),
    (error: unknown) => isPostgresError(error, "23514"),
    "fonte sem nenhuma origem identificável deve violar o CHECK origin_check",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memories (tenant_id, user_id, scope, content, dedup_key)
       values ($1, $2, 'tenant', '', 'empty-content-key')`,
      [tenantA, userA],
    ),
    (error: unknown) => isPostgresError(error, "23514"),
    "content vazio deve violar o CHECK ai_memories_content_check",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memories (tenant_id, user_id, scope, content, dedup_key, confidence)
       values ($1, $2, 'tenant', 'confiança fora da faixa', 'confidence-range-key', 1.5)`,
      [tenantA, userA],
    ),
    (error: unknown) => isPostgresError(error, "23514"),
    "confidence fora de [0,1] deve violar o CHECK ai_memories_confidence_check",
  );

  await assert.rejects(
    pool.query(
      `insert into ai_memories (tenant_id, user_id, scope, content, dedup_key, importance)
       values ($1, $2, 'tenant', 'importância fora da faixa', 'importance-range-key', -0.1)`,
      [tenantA, userA],
    ),
    (error: unknown) => isPostgresError(error, "23514"),
    "importance fora de [0,1] deve violar o CHECK ai_memories_importance_check",
  );

  // O escopo da busca é do chamador e não amplia o tenant: um filtro que não
  // casa não pode vazar para o resto do tenant.
  const wrongScope = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestA, transaction), {
      text: "relatórios semanais",
      scopes: ["user"],
    }),
  );
  assert.deepEqual(
    wrongScope,
    [],
    "o filtro de escopo deve excluir a memória de escopo 'conversation'",
  );

  console.log(
    "T2 proveniência: search devolve a fonte mais antiga; órfã/sem origem impossíveis (23503/23514): OK",
  );
}

/**
 * T3 (c) — atomicidade com o efeito de domínio, nas duas direções:
 * rollback depois dos dois deixa zero memória e zero despesa; e a memória
 * recusada pelo banco (CHECK) desfaz a despesa da mesma transação.
 */
async function t3AtomicWithDomainEffect(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  await assert.rejects(
    withTenantTransaction(identityA, async (transaction) => {
      const context = bindTransactionContext(requestA, transaction);
      const saved = await expenseRepository.save(context, {
        ...expenseFixture,
        name: "Despesa revertida com memória",
      });
      assert.ok(saved.id, "a mutação de domínio deve produzir uma despesa");
      await memoryRepository.append(context, memoryInput());
      throw new Error("falha simulada depois da memória e da despesa");
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("falha simulada depois da memória"),
    "a transação deve propagar a falha posterior às duas mutações",
  );

  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where tenant_id = $1", [
      tenantA,
    ]),
    0,
    "rollback do domínio não pode deixar memória órfã",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_sources where tenant_id = $1",
      [tenantA],
    ),
    0,
    "rollback do domínio não pode deixar fonte órfã",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from expenses where name = $1", [
      "Despesa revertida com memória",
    ]),
    0,
    "rollback não pode deixar a despesa",
  );

  await assert.rejects(
    withTenantTransaction(identityA, async (transaction) => {
      const context = bindTransactionContext(requestA, transaction);
      const saved = await expenseRepository.save(context, {
        ...expenseFixture,
        name: "Despesa desfeita pela memória",
      });
      assert.ok(saved.id);
      await memoryRepository.append(context, memoryInput({ content: "" }));
    }),
    (error: unknown) => isPostgresError(error, "23514"),
    "memória com content vazio deve violar o CHECK e abortar a transação inteira",
  );

  assert.equal(
    await countRows(pool, "select count(*)::text as count from expenses where name = $1", [
      "Despesa desfeita pela memória",
    ]),
    0,
    "falha da memória deve desfazer o efeito de domínio da mesma transação",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where tenant_id = $1", [
      tenantA,
    ]),
    0,
    "a memória recusada não pode persistir",
  );

  const committed = await withTenantTransaction(identityA, async (transaction) => {
    const context = bindTransactionContext(requestA, transaction);
    const saved = await expenseRepository.save(context, {
      ...expenseFixture,
      name: "Despesa commitada com memória",
    });
    const { record: memory } = await memoryRepository.append(context, memoryInput());
    return { expenseId: saved.id, memoryId: memory.id };
  });
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where id = $1", [
      committed.memoryId,
    ]),
    1,
    "o commit deve persistir a memória junto do efeito de domínio",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from expenses where id = $1", [
      committed.expenseId,
    ]),
    1,
  );

  console.log(
    "T3 atomicidade: rollback e falha cruzadas entre memória e despesa deixam zero linhas: OK",
  );
}

/**
 * T4 (d) — delete: `true` só quando a linha do tenant corrente cai; id
 * inexistente devolve `false`; id de outro tenant devolve `false` e não apaga
 * nada; a fonte cai em cascata; a role de runtime tem DELETE concedido.
 */
async function t4Delete(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const { record: mine } = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const removalByRuntime = await withRuntimeRoleTransaction(pool, identityA, (transaction) =>
    memoryRepository.delete(bindTransactionContext(requestA, transaction), mine.id),
  );
  assert.equal(
    removalByRuntime,
    true,
    "a role de runtime precisa ter DELETE concedido e a policy USING precisa alcançar a linha",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where id = $1", [
      mine.id,
    ]),
    0,
    "o delete deve remover a linha do tenant corrente",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_sources where memory_id = $1",
      [mine.id],
    ),
    0,
    "a fonte deve cair em cascata com a memória",
  );

  const missing = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.delete(
      bindTransactionContext(requestA, transaction),
      "c8000000-0000-4000-8000-000000000008",
    ),
  );
  assert.equal(missing, false, "delete de id inexistente devolve false");

  const { record: foreignKeyRow } = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const removalByB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.delete(bindTransactionContext(requestB, transaction), foreignKeyRow.id),
  );
  assert.equal(removalByB, false, "delete sob outra identidade não afeta a linha de A");
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where id = $1", [
      foreignKeyRow.id,
    ]),
    1,
    "a linha de A permanece intacta",
  );

  const ownRemoval = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.delete(bindTransactionContext(requestA, transaction), foreignKeyRow.id),
  );
  assert.equal(ownRemoval, true, "A apaga a própria memória");
  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(bindTransactionContext(requestA, transaction), foreignKeyRow.id),
    ),
    false,
    "o delete é idempotente: a segunda chamada devolve false",
  );

  const metadata = await pool.query<{
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
    publicSelect: boolean;
    policies: string;
  }>(
    `select c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', 'public.ai_memories', 'select') as "select",
            has_table_privilege('app_runtime', 'public.ai_memories', 'insert') as "insert",
            has_table_privilege('app_runtime', 'public.ai_memories', 'update') as "update",
            has_table_privilege('app_runtime', 'public.ai_memories', 'delete') as "delete",
            has_table_privilege('public', 'public.ai_memories', 'select') as "publicSelect",
            (select string_agg(p.policyname || ':' || coalesce(p.qual, '-') || ':' || coalesce(p.with_check, '-'), '|')
               from pg_policies p
              where p.schemaname = 'public' and p.tablename = 'ai_memories') as "policies"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'ai_memories'`,
  );
  const memoryMetadata = metadata.rows[0];
  assert.equal(memoryMetadata?.rowSecurity, true, "ai_memories deve ter RLS habilitado");
  assert.deepEqual(
    {
      select: memoryMetadata?.select,
      insert: memoryMetadata?.insert,
      update: memoryMetadata?.update,
      delete: memoryMetadata?.delete,
      publicSelect: memoryMetadata?.publicSelect,
    },
    { select: true, insert: true, update: true, delete: true, publicSelect: false },
    "ai_memories deve ter SELECT/INSERT/UPDATE/DELETE para app_runtime e nada para PUBLIC",
  );
  assert.match(
    memoryMetadata?.policies ?? "",
    /^tenant_isolation:.*current_tenant_id.*has_tenant_access.*:.*current_tenant_id.*has_tenant_access.*$/,
    "a policy tenant_isolation precisa ter USING e WITH CHECK com has_tenant_access",
  );

  const sourceMetadata = await pool.query<{
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    delete: boolean;
    publicSelect: boolean;
  }>(
    `select c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', 'public.ai_memory_sources', 'select') as "select",
            has_table_privilege('app_runtime', 'public.ai_memory_sources', 'insert') as "insert",
            has_table_privilege('app_runtime', 'public.ai_memory_sources', 'delete') as "delete",
            has_table_privilege('public', 'public.ai_memory_sources', 'select') as "publicSelect"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'ai_memory_sources'`,
  );
  assert.deepEqual(
    sourceMetadata.rows[0],
    { rowSecurity: true, select: true, insert: true, delete: false, publicSelect: false },
    "ai_memory_sources deve ser append-only para app_runtime e fechada para PUBLIC",
  );

  const invalidLimit = await withTenantTransaction(identityA, (transaction) =>
    assert.rejects(
      memoryRepository.search(bindTransactionContext(requestA, transaction), {
        text: "relatórios",
        limit: 0,
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_ERROR",
      "limite inválido deve falhar alto em vez de virar varredura",
    ),
  );
  assert.equal(invalidLimit, undefined);

  console.log(
    "T4 delete: só o tenant corrente apaga, cascata na fonte, false para id inexistente e de terceiro: OK",
  );
}

/** T5 (e) — a migration nova está classificada e tem down no registry §27a. */
async function t5MigrationClassification(): Promise<void> {
  const result = await classifyProject(process.cwd());
  assert.deepEqual(result.errors, [], "o registry de classes precisa estar sem divergências");
  assert.equal(
    result.classified,
    result.total,
    "todas as migrations do journal precisam estar classificadas",
  );

  const entry = result.rows.find((row) => row.tag === MEMORY_MIGRATION_TAG);
  assert.ok(entry, `a migration ${MEMORY_MIGRATION_TAG} precisa estar no journal e no registry`);
  assert.equal(entry.class, "SAFE", "tabelas novas sem DML são SAFE (§27)");
  assert.equal(entry.appliedOn, "empty");
  assert.equal(entry.ok, true);

  await assert.doesNotReject(
    readFile(resolve("drizzle/rollback", MEMORY_MIGRATION_DOWN), "utf8"),
    `o down ${MEMORY_MIGRATION_DOWN} precisa existir`,
  );

  console.log(
    `T5 classificação: ${result.classified}/${result.total} classificadas · ${MEMORY_MIGRATION_TAG} = SAFE/empty + down: OK`,
  );
}

/* ------------------------------------------------------------------------- *
 * D3 — dedup (T1/T5/T6), versionamento (T2/T4/T7), conflito (T3) e
 * classificação (T8). Toda asserção de "não mudou" compara os BYTES lidos do
 * banco (não o objeto devolvido pelo repositório).
 * ------------------------------------------------------------------------- */

/** Linha de `ai_memories` como o banco a guarda — a comparação byte a byte de
 * T2/T3/T4 usa exatamente estas colunas. */
function memoryBytes(pool: Pool, id: string): Promise<Record<string, unknown> | undefined> {
  return pool
    .query<Record<string, unknown>>(
      `select tenant_id, user_id, scope, content, dedup_key, importance, confidence,
              status, created_at, updated_at
         from ai_memories where id = $1`,
      [id],
    )
    .then((result) => result.rows[0]);
}

/** Linha de `ai_memory_versions` como o banco a guarda (T2/T4/T7). */
function versionBytes(pool: Pool, id: string): Promise<Record<string, unknown> | undefined> {
  return pool
    .query<Record<string, unknown>>(
      `select tenant_id, memory_id, version, content, dedup_key, created_at
         from ai_memory_versions where id = $1`,
      [id],
    )
    .then((result) => result.rows[0]);
}

/** Contagens do agregado de memória do tenant A (a "contagem não mudou" de T1 e
 * a prova de expurgo de T4). */
async function memoryCounts(
  pool: Pool,
  tenantId: string,
  memoryId?: string,
): Promise<{ memories: number; sources: number; versions: number; conflicts: number }> {
  const [memories, sources, versions, conflicts] = await Promise.all([
    countRows(pool, "select count(*)::text as count from ai_memories where tenant_id = $1", [
      tenantId,
    ]),
    countRows(pool, "select count(*)::text as count from ai_memory_sources where tenant_id = $1", [
      tenantId,
    ]),
    countRows(
      pool,
      memoryId === undefined
        ? "select count(*)::text as count from ai_memory_versions where tenant_id = $1"
        : "select count(*)::text as count from ai_memory_versions where tenant_id = $1 and memory_id = $2",
      memoryId === undefined ? [tenantId] : [tenantId, memoryId],
    ),
    countRows(
      pool,
      memoryId === undefined
        ? "select count(*)::text as count from ai_memory_conflicts where tenant_id = $1"
        : "select count(*)::text as count from ai_memory_conflicts where tenant_id = $1 and memory_id = $2",
      memoryId === undefined ? [tenantId] : [tenantId, memoryId],
    ),
  ]);
  return { memories, sources, versions, conflicts };
}

/**
 * D3/T1 — dedup idempotente: a 2ª gravação do mesmo conteúdo (mesma chave)
 * devolve a memória existente com `duplicated: true` e **nada** é gravado — nem
 * memória, nem fonte, nem versão. A chave é normalizada (NFC/trim/espaços), mas
 * não dobra caixa.
 */
async function d3T1DedupIdempotent(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const first = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  assert.equal(first.duplicated, false, "a 1ª gravação cria a memória");
  assert.equal(
    (await memoryCounts(pool, tenantA)).memories,
    1,
    "a 1ª gravação deve deixar exatamente uma memória",
  );

  // Mesmo conteúdo com outra FORMA: NFC + trim + colapso de espaços internos
  // (tab/quebra) têm de produzir a mesma chave.
  const second = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({
        content: "  Preferência:\trelatórios\n semanais com margem  por produto  ",
        provenance: undefined,
      }),
    ),
  );
  assert.equal(second.duplicated, true, "a 2ª gravação idêntica devolve duplicated: true");
  assert.equal(second.record.id, first.record.id, "e devolve a memória que já existia");
  assert.equal(
    second.record.content,
    first.record.content,
    "o dedup não reescreve o conteúdo armazenado (a normalização alimenta só a chave)",
  );

  const afterDuplicate = await memoryCounts(pool, tenantA);
  assert.deepEqual(
    afterDuplicate,
    { memories: 1, sources: 1, versions: 0, conflicts: 0 },
    "a duplicata não pode criar linha de memória, fonte ou versão",
  );
  assert.equal(
    await runtimeCount(pool, identityA, "ai_memories"),
    1,
    "sob app_runtime com o GUC de A a contagem (não vacuosa) precisa continuar 1",
  );

  // Invisível também é FORMA, não conteúdo: a categoria `Cf` sai antes do
  // colapso de espaços (C2.5), então um ZWSP no meio da palavra — texto
  // visualmente idêntico ao da 1ª gravação — tem de deduplicar.
  const invisible = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({
        content: "Preferência: relat\u200bórios semanais com margem por produto",
        provenance: undefined,
      }),
    ),
  );
  assert.equal(
    invisible.duplicated,
    true,
    "um U+200B no meio da palavra não pode criar memória nova",
  );
  assert.equal(invisible.record.id, first.record.id, "e devolve a memória que já existia");
  assert.deepEqual(
    await memoryCounts(pool, tenantA),
    afterDuplicate,
    "o invisível colapsado não pode mudar contagem alguma",
  );

  // Caixa NÃO entra na normalização (decisão registrada): conteúdo diferente.
  const differentCase = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "preferência: relatórios semanais com margem por produto" }),
    ),
  );
  assert.equal(differentCase.duplicated, false, "caixa diferente é conteúdo diferente");
  assert.equal((await memoryCounts(pool, tenantA)).memories, 2);

  console.log(
    "D3/T1 dedup: 2ª gravação idêntica = duplicated:true + contagem inalterada (memória/fonte/versão): OK",
  );
}

/**
 * D3/T2 — revisão: arquiva o estado substituído com `version` incremental e o
 * head passa a valer o conteúdo novo. As versões anteriores ficam byte a byte
 * inalteradas (§34) — provado comparando o que o banco guarda antes e depois da
 * segunda revisão.
 */
async function d3T2Revision(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const created = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const originalBytes = await memoryBytes(pool, created.record.id);
  assert.equal(originalBytes?.content, created.record.content);

  const revisedContent = "Preferência: relatórios quinzenais com margem por produto";
  const revised = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.revise(bindTransactionContext(requestA, transaction), created.record.id, {
      content: revisedContent,
      importance: 0.8,
    }),
  );
  assert.equal(revised.id, created.record.id, "a revisão não cria outra memória");
  assert.equal(revised.content, revisedContent);
  assert.equal(revised.importance, 0.8, "a revisão atualiza o head in-place");

  const firstVersions = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.listVersions(bindTransactionContext(requestA, transaction), created.record.id),
  );
  assert.equal(firstVersions.length, 1, "a 1ª revisão arquiva exatamente uma versão");
  assert.equal(firstVersions[0]?.version, 1, "a numeração começa em 1");
  assert.equal(
    firstVersions[0]?.content,
    created.record.content,
    "a versão arquivada é o estado SUBSTITUÍDO (o head passa a ter o novo)",
  );
  assert.equal(
    firstVersions[0]?.dedupKey,
    originalBytes?.dedup_key,
    "a versão guarda a chave do estado substituído",
  );
  const archivedId = firstVersions[0]?.id as string;
  const archivedBytes = await versionBytes(pool, archivedId);

  // 2ª revisão: nova linha, numeração incremental e a anterior intacta.
  const secondContent = "Preferência: relatórios mensais consolidados por produto";
  const secondRevision = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.revise(bindTransactionContext(requestA, transaction), created.record.id, {
      content: secondContent,
      provenance: {
        sourceKind: "model",
        sourceId: "model:revision-2",
        capturedAt: new Date("2026-09-16T13:30:00.000Z"),
        inferred: true,
        confidence: 0.55,
      },
    }),
  );
  assert.equal(secondRevision.content, secondContent);

  const versions = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.listVersions(bindTransactionContext(requestA, transaction), created.record.id),
  );
  assert.deepEqual(
    versions.map((version) => version.version),
    [1, 2],
    "cada revisão arquiva uma versão com número incremental",
  );
  assert.equal(versions[1]?.content, revisedContent, "a 2ª versão é o estado da 1ª revisão");
  assert.deepEqual(
    await versionBytes(pool, archivedId),
    archivedBytes,
    "a versão anterior precisa ficar byte a byte inalterada (content/dedup_key/created_at)",
  );
  assert.equal(
    versions[0]?.superseded,
    true,
    "a marcação superseded é derivada (o head é a versão corrente da memória)",
  );

  const memory = await memoryBytes(pool, created.record.id);
  assert.equal(memory?.content, secondContent, "o head terminou com o último conteúdo");
  assert.notEqual(
    memory?.dedup_key,
    versions[1]?.dedupKey,
    "a chave do head descreve o estado atual, não o anterior",
  );
  assert.notEqual(memory?.dedup_key, versions[0]?.dedupKey);

  // A observação da revisão entra como fonte (proveniência 1:N), e o read model
  // continua expondo a fonte mais antiga.
  assert.equal(
    (await memoryCounts(pool, tenantA, created.record.id)).sources,
    2,
    "a revisão com proveniência acrescenta a observação às fontes",
  );
  assert.equal(
    secondRevision.provenance?.sourceId,
    "chat-message-42",
    "o read model segue expondo a fonte mais antiga",
  );

  // Revisão sem alteração de conteúdo (mesma chave) falha alto e não cria versão.
  await assert.rejects(
    withTenantTransaction(identityA, (transaction) =>
      memoryRepository.revise(bindTransactionContext(requestA, transaction), created.record.id, {
        content: ` ${secondContent} `,
      }),
    ),
    (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_ERROR",
    "revisão sem alteração de conteúdo deve falhar alto",
  );
  assert.equal(
    (await memoryCounts(pool, tenantA, created.record.id)).versions,
    2,
    "a revisão recusada não pode arquivar versão",
  );

  // Revisão de memória inexistente (ou de outro tenant) é NOT_FOUND, não criação.
  await assert.rejects(
    withTenantTransaction(identityB, (transaction) =>
      memoryRepository.revise(bindTransactionContext(requestB, transaction), created.record.id, {
        content: "revisão de memória de outro tenant",
      }),
    ),
    (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND",
    "a revisão é restrita ao tenant corrente",
  );

  console.log(
    "D3/T2 revisão: versão incremental arquivada, anterior byte a byte inalterada, head atualizado: OK",
  );
}

/**
 * D3/T3 — conflito registrado: `ai_memory_conflicts` ganha a linha, a memória
 * ativa fica **byte a byte** inalterada e o `search` continua devolvendo só o
 * ativo (o candidato não vira memória). D3 não julga contradição (SD-C3-5).
 */
async function d3T3Conflict(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const active = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const before = await memoryBytes(pool, active.record.id);

  const candidateContent = "Preferência: relatórios diários com margem por produto";
  const conflict = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.recordConflict(
      bindTransactionContext(requestA, transaction),
      active.record.id,
      memoryInput({ content: candidateContent }),
    ),
  );
  assert.equal(conflict.memoryId, active.record.id);
  assert.equal(conflict.candidateContent, candidateContent);
  assert.equal(conflict.status, "open", "conflito nasce aberto");
  assert.equal(conflict.resolvedAt, null, "e sem resolução");
  assert.match(
    conflict.candidateDedupKey,
    /^[0-9a-f]{64}$/,
    "a chave do candidato é o mesmo sha256 hex do read model de dedup",
  );

  assert.deepEqual(
    await memoryBytes(pool, active.record.id),
    before,
    "o conflito não pode sobrescrever o ativo (comparação byte a byte)",
  );
  assert.deepEqual(
    await memoryCounts(pool, tenantA),
    { memories: 1, sources: 1, versions: 0, conflicts: 1 },
    "conflito não cria memória nem versão",
  );

  const found = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestA, transaction), {
      text: "relatórios",
    }),
  );
  assert.equal(found.length, 1, "o search continua devolvendo apenas o ativo");
  assert.equal(found[0]?.content, active.record.content);
  const candidateSearch = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestA, transaction), {
      text: "diários",
    }),
  );
  assert.deepEqual(candidateSearch, [], "o candidato em conflito não entra no retrieval");

  const openConflicts = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.listConflicts(bindTransactionContext(requestA, transaction), {
      status: "open",
    }),
  );
  assert.equal(openConflicts.length, 1);
  assert.equal(openConflicts[0]?.id, conflict.id);
  assert.deepEqual(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.listConflicts(bindTransactionContext(requestA, transaction), {
        status: "resolved",
      }),
    ),
    [],
    "o filtro de status não devolve conflito aberto",
  );
  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.listConflicts(bindTransactionContext(requestA, transaction), {
        memoryId: "c8000000-0000-4000-8000-000000000008",
      }),
    ).then((rows) => rows.length),
    0,
    "o filtro por memória não devolve conflito de outra memória",
  );

  // Isolamento: o conflito de A é invisível para B (não vacuoso: A enxerga 1).
  assert.equal(await runtimeCount(pool, identityB, "ai_memory_conflicts"), 0);
  assert.equal(await runtimeCount(pool, identityA, "ai_memory_conflicts"), 1);

  await assert.rejects(
    withTenantTransaction(identityA, (transaction) =>
      memoryRepository.recordConflict(
        bindTransactionContext(requestA, transaction),
        "c7000000-0000-4000-8000-000000000007",
        memoryInput({ content: "candidato sem memória" }),
      ),
    ),
    (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND",
    "conflito contra memória inexistente é NOT_FOUND",
  );

  console.log(
    "D3/T3 conflito: registrado e visível só no tenant, ativo byte a byte intacto, search só do ativo: OK",
  );
}

/**
 * D3/T4 — delete × expurgo: memória com histórico (ou com conflito) é recusada
 * sem apagar nada; o expurgo apaga versões+conflitos+fontes+memória na MESMA
 * transação — provado com um rollback depois do expurgo.
 */
async function d3T4DeleteWithHistory(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const withHistory = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const untouched = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "Memória sem histórico, apagável pela semântica do D2" }),
    ),
  );

  // Sem histórico o delete do D2 continua valendo (o expurgo não virou obrigatório).
  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(bindTransactionContext(requestA, transaction), untouched.record.id),
    ),
    true,
    "memória sem histórico continua apagável pelo delete do D2",
  );

  await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.revise(bindTransactionContext(requestA, transaction), withHistory.record.id, {
      content: "Preferência revisada: relatórios semanais com margem por produto",
    }),
  );
  await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.recordConflict(
      bindTransactionContext(requestA, transaction),
      withHistory.record.id,
      memoryInput({ content: "Preferência contraditória: relatórios diários" }),
    ),
  );
  const beforeRefusal = await memoryCounts(pool, tenantA, withHistory.record.id);
  assert.deepEqual(
    beforeRefusal,
    { memories: 1, sources: 1, versions: 1, conflicts: 1 },
    "o cenário da recusa precisa ter histórico E conflito",
  );

  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(bindTransactionContext(requestA, transaction), withHistory.record.id),
    ),
    false,
    "delete de memória com histórico devolve false, sem erro",
  );
  assert.deepEqual(
    await memoryCounts(pool, tenantA, withHistory.record.id),
    beforeRefusal,
    "a recusa não pode apagar nada",
  );

  // Expurgo na MESMA transação: o rollback depois do delete desfaz tudo.
  await assert.rejects(
    withTenantTransaction(identityA, async (transaction) => {
      const removed = await memoryRepository.delete(
        bindTransactionContext(requestA, transaction),
        withHistory.record.id,
        { purgeHistory: true },
      );
      assert.equal(removed, true, "o expurgo remove a memória");
      throw new Error("falha simulada depois do expurgo");
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("falha simulada depois do expurgo"),
    "o expurgo precisa participar da transação do chamador",
  );
  assert.deepEqual(
    await memoryCounts(pool, tenantA, withHistory.record.id),
    beforeRefusal,
    "rollback do expurgo devolve memória, fonte, versão e conflito (mesma transação)",
  );

  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(
        bindTransactionContext(requestA, transaction),
        withHistory.record.id,
        { purgeHistory: true },
      ),
    ),
    true,
    "o expurgo apaga a memória com histórico",
  );
  assert.deepEqual(
    await memoryCounts(pool, tenantA, withHistory.record.id),
    { memories: 0, sources: 0, versions: 0, conflicts: 0 },
    "o expurgo apaga versões, conflitos, fontes e a memória",
  );
  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(
        bindTransactionContext(requestA, transaction),
        withHistory.record.id,
        { purgeHistory: true },
      ),
    ),
    false,
    "o expurgo é idempotente (2ª chamada devolve false)",
  );

  // O RESTRICT do banco é a garantia estrutural da recusa: sem a checagem da
  // aplicação o DELETE abortaria a transação em vez de levar o histórico junto.
  // (a checagem existe; aqui provamos que a FK é RESTRICT e não CASCADE)
  const restrict = await pool.query<{ confdeltype: string }>(
    `select confdeltype from pg_constraint
      where conname in (
        'ai_memory_versions_tenant_id_memory_id_ai_memories_tenant_id_id_fk',
        'ai_memory_conflicts_tenant_id_memory_id_ai_memories_tenant_id_id_fk'
      )
      order by conname`,
  );
  assert.deepEqual(
    restrict.rows.map((row) => row.confdeltype),
    ["r", "r"],
    "as FKs do histórico e do conflito são ON DELETE RESTRICT",
  );

  console.log(
    "D3/T4 delete × expurgo: recusa sem apagar + expurgo transacional (rollback devolve tudo): OK",
  );
}

/** Sessão própria com transação manual, para a corrida real de D3/T5: o
 * `Executor` é o Drizzle sobre o client, então cada `append` roda na MESMA
 * conexão (e na mesma transação) da sua sessão. */
async function openRuntimeSession(
  pool: Pool,
  identity: DatabaseIdentity,
): Promise<{ client: PoolClient; executor: DatabaseTransaction; pid: number }> {
  const client = await pool.connect();
  const database = drizzle({ client, schema });
  await client.query("begin");
  await client.query("set local role app_runtime");
  await client.query("select set_config('app.current_user_id', $1, true)", [identity.userId]);
  await client.query("select set_config('app.current_tenant_id', $1, true)", [identity.tenantId]);
  await client.query("select set_config('app.current_roles', $1, true)", [
    identity.roles.join(","),
  ]);
  const pid = await client
    .query<{ pid: number }>("select pg_backend_pid() as pid")
    .then((result) => result.rows[0]?.pid as number);
  // O Drizzle sobre o client expõe a mesma superfície usada pelo repositório
  // (insert/select/update/delete/execute); o port tipa o handle transacional.
  return { client, executor: database as unknown as DatabaseTransaction, pid };
}

/** Espera a sessão `pid` entrar em espera de lock — sem isso a "corrida" poderia
 * ser apenas duas gravações sequenciais, e o teste passaria por acidente. */
async function waitForLockWait(pool: Pool, pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await pool
      .query<{ waiting: boolean }>(
        `select coalesce(wait_event_type = 'Lock', false) as waiting
           from pg_stat_activity where pid = $1`,
        [pid],
      )
      .then((result) => result.rows[0]?.waiting === true);
    if (waiting) return;
    if (Date.now() > deadline) {
      throw new Error(`a sessão ${pid} não bloqueou em lock dentro de ${timeoutMs}ms`);
    }
    // `Promise.withResolvers` é ES2024 e o `lib` do projeto é anterior; o repo
    // usa esta forma em `scripts/db/test-ai-budget.ts`.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
}

/**
 * D3/T5 — concorrência real: duas sessões (`app_runtime`, conexões próprias,
 * transações abertas) gravam o MESMO conteúdo; a 2ª fica esperando o índice
 * único parcial e, quando a 1ª commita, o `DO NOTHING` a manda ler a existente.
 * Resultado: exatamente 1 linha ativa, sem erro de unicidade vazando.
 */
async function d3T5ConcurrentAppend(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const content = "Concorrência: a mesma memória gravada em duas sessões";
  const requestA2: RequestIdentity = {
    ...identityA,
    correlationId: "db-test-memory-a2",
    signal: new AbortController().signal,
  };
  const sessionA = await openRuntimeSession(pool, identityA);
  const sessionB = await openRuntimeSession(pool, identityA);

  try {
    const winner = await memoryRepository.append(
      bindTransactionContext(requestA, sessionA.executor),
      memoryInput({ content, provenance: undefined }),
      sessionA.executor,
    );
    assert.equal(winner.duplicated, false, "a 1ª sessão cria a memória");

    // A 2ª INSERT entra em espera de lock no índice único parcial (fica
    // pendente até a 1ª commitar). `pending` só resolve depois do commit.
    const pending = memoryRepository.append(
      bindTransactionContext(requestA2, sessionB.executor),
      memoryInput({ content, provenance: undefined }),
      sessionB.executor,
    );
    await waitForLockWait(pool, sessionB.pid);

    await sessionA.client.query("commit");
    const loser = await pending;
    await sessionB.client.query("commit");

    assert.equal(loser.duplicated, true, "a sessão que perdeu a corrida enxerga a existente");
    assert.equal(loser.record.id, winner.record.id, "as duas sessões convergem para a MESMA linha");
    assert.deepEqual(
      await memoryCounts(pool, tenantA),
      { memories: 1, sources: 0, versions: 0, conflicts: 0 },
      "duas sessões concorrentes deixam exatamente uma memória ativa",
    );

    const active = await pool.query<{ count: string }>(
      `select count(*)::text as count from ai_memories
        where tenant_id = $1 and dedup_key = (
          select dedup_key from ai_memories where tenant_id = $1
        ) and status = 'active'`,
      [tenantA],
    );
    assert.equal(active.rows[0]?.count, "1", "só uma linha ativa para a chave disputada");
  } finally {
    await sessionA.client.query("rollback").catch(() => undefined);
    await sessionB.client.query("rollback").catch(() => undefined);
    sessionA.client.release();
    sessionB.client.release();
  }

  console.log(
    "D3/T5 concorrência: 2 sessões no mesmo conteúdo ⇒ 1 linha ativa (índice único parcial): OK",
  );
}

/**
 * D3/T6 — o dedup é por tenant: o mesmo conteúdo em dois tenants são duas
 * memórias, e B não enxerga a de A. O discriminador da chave (conversa) também
 * não colapsa duas conversas do mesmo tenant com o mesmo texto.
 */
async function d3T6DedupTenantIsolation(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  // Segundo membro do tenant A com a própria conversa (o índice de conversas é
  // único por (tenant, usuário)).
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, 'Memória C', 'memory-c@example.test', true)
     on conflict (id) do nothing`,
    [userC],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'member')
     on conflict (tenant_id, user_id) do nothing`,
    [tenantA, userC],
  );
  await pool.query(
    `insert into chat_conversations (id, tenant_id, user_id) values ($1, $2, $3)
     on conflict (id) do nothing`,
    [conversationA2, tenantA, userC],
  );

  const inTenantA = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const inTenantB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestB, transaction), memoryInput()),
  );
  assert.equal(
    inTenantB.duplicated,
    false,
    "o mesmo conteúdo (e o mesmo escopo) em outro tenant é memória nova",
  );
  assert.notEqual(inTenantA.record.id, inTenantB.record.id);
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where content = $1", [
      memoryInput().content,
    ]),
    2,
    "o mesmo conteúdo em dois tenants precisa render duas linhas",
  );
  assert.equal(await runtimeCount(pool, identityA, "ai_memories"), 1);
  assert.equal(await runtimeCount(pool, identityB, "ai_memories"), 1);

  const seenByB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestB, transaction), {
      text: "relatórios semanais",
    }),
  );
  assert.equal(seenByB.length, 1, "B vê a própria memória (a busca de B não é vacuosa)");
  assert.equal(seenByB[0]?.id, inTenantB.record.id, "e não vê a de A");

  // Mesmo tenant, mesmo conteúdo, MESMO escopo e conversas diferentes: a chave
  // tem de separar (senão a 2ª seria engolida como "duplicata").
  const conversationAMemory = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({
        scope: "conversation",
        provenance: {
          sourceKind: "user",
          sourceId: "chat-message-7",
          conversationId: conversationA,
          capturedAt: new Date("2026-09-16T12:00:00.000Z"),
          inferred: false,
          confidence: 0.9,
        },
      }),
    ),
  );
  const conversationA2Memory = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({
        scope: "conversation",
        provenance: {
          sourceKind: "user",
          sourceId: "chat-message-8",
          conversationId: conversationA2,
          capturedAt: new Date("2026-09-16T12:00:00.000Z"),
          inferred: false,
          confidence: 0.9,
        },
      }),
    ),
  );
  assert.equal(conversationA2Memory.duplicated, false, "duas conversas ⇒ duas memórias");
  assert.notEqual(conversationAMemory.record.id, conversationA2Memory.record.id);
  assert.equal(
    (await memoryCounts(pool, tenantA)).memories,
    3,
    "as três memórias de A coexistem (tenant, conversa A, conversa A2)",
  );

  console.log(
    "D3/T6 isolamento: mesmo conteúdo em 2 tenants = 2 linhas (B não vê A) + discriminador de conversa: OK",
  );
}

/**
 * D3/T7 — imutabilidade por privilégio, atualizada por **SD-C3-12**: desde a
 * 0019 `app_runtime` **consegue** `INSERT` (controle positivo) e `DELETE` — o
 * expurgo LGPD tem de rodar pela role da aplicação — e **não** consegue `UPDATE`
 * (42501): reescrever o histórico continua impossível, que é a dimensão da
 * imutabilidade que o §34 exige. O alcance do `DELETE` é limitado pela RLS: a
 * versão de outro tenant não é alcançável (0 linhas) e a do próprio tenant é
 * (controle positivo). Os metadados do catálogo fecham a história: RLS ligado,
 * grants mínimos por tabela e nada para PUBLIC.
 */
async function d3T7VersionImmutability(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const created = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.revise(bindTransactionContext(requestA, transaction), created.record.id, {
      content: "Preferência revisada para provar imutabilidade do histórico",
    }),
  );
  const versions = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.listVersions(bindTransactionContext(requestA, transaction), created.record.id),
  );
  const archivedId = versions[0]?.id as string;
  const archivedBytes = await versionBytes(pool, archivedId);
  assert.ok(archivedBytes, "a versão arquivada precisa existir antes das denegações");

  // Controle POSITIVO: a role de runtime insere (a visibilidade/RLS deixa passar).
  await withRuntimeRoleTransaction(pool, identityA, (transaction) =>
    transaction.execute(
      sql`insert into ai_memory_versions (tenant_id, memory_id, version, content, dedup_key)
          values (${tenantA}, ${created.record.id}, 99, 'controle positivo de INSERT', 'positive-control-key')`,
    ),
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_versions where memory_id = $1",
      [created.record.id],
    ),
    2,
    "o INSERT sob app_runtime precisa funcionar (controle positivo)",
  );

  // A linha é visível para a role de runtime com o GUC do tenant: a denegação
  // que vem a seguir não pode ser confundida com "linha invisível por RLS".
  assert.equal(await runtimeCount(pool, identityA, "ai_memory_versions"), 2);

  await expectRuntimeDenial(
    pool,
    identityA,
    "42501",
    (transaction) =>
      transaction.execute(
        sql`update ai_memory_versions set content = 'adulterado' where id = ${archivedId}`,
      ),
    "UPDATE em ai_memory_versions deve ser negado por privilégio (42501)",
  );
  assert.deepEqual(
    await versionBytes(pool, archivedId),
    archivedBytes,
    "depois da tentativa negada a versão continua byte a byte igual",
  );

  // SD-C3-12: em D4 o DELETE passa a ser concedido (o expurgo LGPD tem de rodar
  // sob a role de aplicação) — a imutabilidade do histórico segue enforçada pela
  // negação do UPDATE acima. O controle positivo abaixo apaga a linha de
  // controle; o negativo prova que a RLS limita o alcance ao tenant do GUC.
  await withRuntimeRoleTransaction(pool, identityB, async (transaction) => {
    const created = await memoryRepository.append(
      bindTransactionContext(requestB, transaction),
      memoryInput({ content: "Memória de B para provar o alcance do DELETE por RLS" }),
    );
    await memoryRepository.revise(
      bindTransactionContext(requestB, transaction),
      created.record.id,
      {
        content: "Memória de B revisada para materializar uma versão",
      },
    );
  });
  const foreignVersions = await pool.query<{ id: string }>(
    "select id from ai_memory_versions where tenant_id = $1",
    [tenantB],
  );
  const foreignVersionId = foreignVersions.rows[0]?.id as string;
  assert.ok(foreignVersionId, "a revisão de B precisa ter arquivado uma versão");

  const foreignDeleted = await withRuntimeRoleTransaction(pool, identityA, (transaction) =>
    transaction.execute(sql`delete from ai_memory_versions where id = ${foreignVersionId}`),
  );
  assert.equal(
    foreignDeleted.rowCount,
    0,
    "o DELETE concedido não pode alcançar a versão de outro tenant (RLS USING)",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memory_versions where id = $1", [
      foreignVersionId,
    ]),
    1,
    "a versão de B permanece intacta depois da tentativa de A",
  );

  const purgeControl = await withRuntimeRoleTransaction(pool, identityA, (transaction) =>
    transaction.execute(
      sql`delete from ai_memory_versions
           where memory_id = ${created.record.id} and version = 99 and tenant_id = ${tenantA}`,
    ),
  );
  assert.equal(
    purgeControl.rowCount,
    1,
    "o DELETE concedido (SD-C3-12) precisa remover a linha do próprio tenant (controle positivo)",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_versions where memory_id = $1",
      [created.record.id],
    ),
    1,
    "a linha do próprio tenant sai e a versão legítima do histórico permanece",
  );

  const metadata = await pool.query<{
    table_name: string;
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
    publicSelect: boolean;
    policies: string;
  }>(
    `select c.relname as table_name,
            c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'select') as "select",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'insert') as "insert",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'update') as "update",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'delete') as "delete",
            has_table_privilege('public', 'public.' || c.relname, 'select') as "publicSelect",
            (select string_agg(p.policyname || ':' || coalesce(p.qual, '-') || ':' || coalesce(p.with_check, '-'), '|')
               from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname) as "policies"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('ai_memory_versions', 'ai_memory_conflicts')
      order by c.relname`,
  );
  assert.deepEqual(
    metadata.rows.map((row) => ({
      table: row.table_name,
      rls: row.rowSecurity,
      sel: row.select,
      ins: row.insert,
      upd: row.update,
      del: row.delete,
      pub: row.publicSelect,
    })),
    [
      {
        table: "ai_memory_conflicts",
        rls: true,
        sel: true,
        ins: true,
        upd: true,
        del: true,
        pub: false,
      },
      {
        table: "ai_memory_versions",
        rls: true,
        sel: true,
        ins: true,
        upd: false,
        del: true,
        pub: false,
      },
    ],
    "grants: conflito com SELECT/INSERT/UPDATE/DELETE, histórico com SELECT/INSERT/DELETE (SD-C3-12) e UPDATE negado; nada para PUBLIC",
  );
  for (const row of metadata.rows) {
    assert.match(
      row.policies,
      /^tenant_isolation:.*current_tenant_id.*has_tenant_access.*:.*current_tenant_id.*has_tenant_access.*$/,
      `a policy tenant_isolation de ${row.table_name} precisa ter USING e WITH CHECK com has_tenant_access`,
    );
  }

  console.log(
    "D3/T7 imutabilidade: UPDATE negado (42501) e DELETE concedido com alcance limitado por RLS em ai_memory_versions + grants/RLS: OK",
  );
}

/** D3/T8 — a migration do degrau está `SAFE`/`appliedOn: empty` no registry §27a
 * e tem down (o par que o `db:classify:check` cobre por fora). */
async function d3T8MigrationClassification(): Promise<void> {
  const result = await classifyProject(process.cwd());
  assert.deepEqual(result.errors, [], "o registry de classes precisa estar sem divergências");
  const entry = result.rows.find((row) => row.tag === MEMORY_D3_MIGRATION_TAG);
  assert.ok(entry, `a migration ${MEMORY_D3_MIGRATION_TAG} precisa estar no journal e no registry`);
  assert.equal(
    entry.class,
    "SAFE",
    "tabelas novas + coluna NOT NULL em tabela vazia são SAFE (§27)",
  );
  assert.equal(entry.appliedOn, "empty");
  assert.equal(entry.ok, true);
  await assert.doesNotReject(
    readFile(resolve("drizzle/rollback", MEMORY_D3_MIGRATION_DOWN), "utf8"),
    `o down ${MEMORY_D3_MIGRATION_DOWN} precisa existir`,
  );

  console.log(
    `D3/T8 classificação: ${result.classified}/${result.total} classificadas · ${MEMORY_D3_MIGRATION_TAG} = SAFE/empty + down: OK`,
  );
}

/**
 * D3/T9 — `revise` × colisão de chave (achado C8.5 do veredicto adversarial):
 * revisar a memória A para um conteúdo que **já é o head ativo** da memória B do
 * mesmo tenant. A chave de B está tomada no índice único parcial
 * (`(tenant_id, dedup_key) WHERE status='active'`), então o `UPDATE` do head de
 * A viola 23505. O caminho tem de virar `ApplicationError` (o erro cru do driver
 * viraria 500) e a transação inteira tem de fazer rollback — inclusive a versão
 * que o `revise` arquiva **antes** do `UPDATE`: colisão não deixa rastro.
 */
async function d3T9ReviseKeyCollision(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const first = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  const second = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "Preferência: relatórios mensais consolidados por produto" }),
    ),
  );
  assert.equal(first.duplicated, false, "o 1º conteúdo cria a memória A");
  assert.equal(second.duplicated, false, "o 2º conteúdo é DISTINTO e cria a memória B");

  const firstBytes = await memoryBytes(pool, first.record.id);
  const secondBytes = await memoryBytes(pool, second.record.id);
  const countsBefore = await memoryCounts(pool, tenantA);
  assert.equal(countsBefore.versions, 0, "controle prévio: ainda não existe versão arquivada");

  // A revisão de A para o conteúdo de B colide com a chave ativa de B.
  await assert.rejects(
    withTenantTransaction(identityA, (transaction) =>
      memoryRepository.revise(bindTransactionContext(requestA, transaction), first.record.id, {
        content: second.record.content,
      }),
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof ApplicationError,
        `a colisão tem de virar ApplicationError, não o 23505 cru do driver (recebido: ${String(error)})`,
      );
      assert.equal(
        error.code,
        "CONFLICT",
        "a colisão de chave é um conflito de estado, não erro interno",
      );
      assert.equal(error.status, 409);
      assert.equal((error as Error).name, "ApplicationError");
      return true;
    },
    "revisão para conteúdo já ativo em outra memória deve falhar alto como ApplicationError",
  );

  // Rollback sem rastro: memória, versão, fonte e conflito com a contagem de antes.
  assert.deepEqual(
    await memoryBytes(pool, first.record.id),
    firstBytes,
    "o head de A fica byte a byte inalterado (nem conteúdo, nem dedup_key, nem updated_at)",
  );
  assert.deepEqual(
    await memoryBytes(pool, second.record.id),
    secondBytes,
    "o head de B não é tocado",
  );
  assert.deepEqual(
    await memoryCounts(pool, tenantA),
    countsBefore,
    "a revisão colidente não pode arquivar versão nem gravar nada (rollback)",
  );

  // Controle positivo: a revisão legítima do MESMO head continua funcionando.
  const revisedContent = "Preferência: relatórios anuais com margem por produto";
  const revised = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.revise(bindTransactionContext(requestA, transaction), first.record.id, {
      content: revisedContent,
    }),
  );
  assert.equal(
    revised.id,
    first.record.id,
    "a revisão legítima continua atualizando o head in-place",
  );
  assert.equal(revised.content, revisedContent);
  assert.equal(
    (await memoryCounts(pool, tenantA, first.record.id)).versions,
    1,
    "a revisão legítima arquiva exatamente a versão do estado substituído",
  );

  console.log(
    "D3/T9 revisão × colisão de chave: ApplicationError/CONFLICT com rollback sem rastro + revisão legítima: OK",
  );
}

/* ------------------------------------------------------------------------- *
 * D4 — delete/export + trilha de auditoria + TTL por camada (§43/§15.4/H-12).
 *
 * Os casos medem o banco: as denegações sob `app_runtime` com GUC por transação
 * (o admin do container é superuser e bypassaria RLS) e as permissões de tabela
 * pelo catálogo. Nenhum resultado é inferido de filtro de aplicação.
 * ------------------------------------------------------------------------- */

/** Ids das linhas de `ai_memory_access_log` do tenant, do mais recente ao mais
 * antigo — é a leitura crua que confere a trilha gravada pela aplicação. */
async function accessLogRows(
  pool: Pool,
  tenantId: string,
): Promise<
  Array<{
    action: string;
    result: string;
    memory_id: string | null;
    row_count: number;
    user_id: string;
  }>
> {
  const result = await pool.query<{
    action: string;
    result: string;
    memory_id: string | null;
    row_count: number;
    user_id: string;
  }>(
    `select action, result, memory_id, row_count, user_id
       from ai_memory_access_log
      where tenant_id = $1
      order by created_at asc, id asc`,
    [tenantId],
  );
  return result.rows;
}

/** TTL vigente por camada (maior versão publicada), lido das linhas — a mesma
 * fonte que o repositório usa: nenhum valor esperado é duplicado no teste. */
async function publishedTtlSeconds(pool: Pool): Promise<Record<string, number | null>> {
  const rows = await pool.query<{ layer: string; ttl_seconds: number | null }>(
    `select distinct on (layer) layer, ttl_seconds
       from ai_memory_policies
      order by layer, version desc`,
  );
  const table: Record<string, number | null> = {};
  for (const row of rows.rows) table[row.layer] = row.ttl_seconds;
  return table;
}

/** Janela de validade efetiva da memória, em segundos — `expires_at - created_at`
 * medido no BANCO (as duas colunas nascem na mesma transação do append). */
async function expiryWindowSeconds(pool: Pool, id: string): Promise<number | null> {
  const result = await pool.query<{ seconds: string | null }>(
    `select case when expires_at is null then null
                 else floor(extract(epoch from expires_at - created_at))::text end as seconds
       from ai_memories where id = $1`,
    [id],
  );
  const seconds = result.rows[0]?.seconds;
  return seconds === null || seconds === undefined ? null : Number(seconds);
}

/**
 * D4/T1 — export (§43, H-12 critério 4): o pacote do tenant A é **exatamente** o
 * conjunto de A (com fontes e versões) e nada de B; o de B é o de B (controle
 * positivo). O recorte por camada/escopo é medido, e a identidade sem
 * `has_tenant_access` recebe `AUTHORIZATION_ERROR` — nunca pacote vazio.
 */
async function d4T1ExportTenantIsolation(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const revised = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "Memória de A com histórico e duas fontes", layer: "L3" }),
    ),
  );
  await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.revise(bindTransactionContext(requestA, transaction), revised.record.id, {
      content: "Memória de A revisada (versão arquivada)",
    }),
  );
  // Segunda fonte da mesma memória: a exportação carrega a proveniência
  // INTEIRA, não só a primária do read model.
  await pool.query(
    `insert into ai_memory_sources
       (tenant_id, memory_id, source_kind, source_ref, confidence, captured_at)
     values ($1, $2, 'model', 'model:segunda-fonte', 0.4, $3)`,
    [tenantA, revised.record.id, new Date("2026-09-16T15:00:00.000Z")],
  );
  const personal = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ scope: "user", content: "Memória pessoal de A", layer: "L1" }),
    ),
  );
  const fromB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestB, transaction),
      memoryInput({ content: "Memória de B que nunca pode entrar no pacote de A" }),
    ),
  );

  const bundleA = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.export(bindTransactionContext(requestA, transaction)),
  );
  assert.equal(bundleA.tenantId, tenantA, "o pacote pertence ao tenant do contexto");
  assert.deepEqual(
    bundleA.memories.map((memory) => memory.record.id).sort(),
    [revised.record.id, personal.record.id].sort(),
    "o export de A devolve exatamente as memórias de A",
  );
  assert.equal(
    bundleA.memories.some((memory) => memory.record.id === fromB.record.id),
    false,
    "nenhuma memória de B entra no pacote de A",
  );

  const exported = bundleA.memories.find((memory) => memory.record.id === revised.record.id);
  assert.ok(exported, "a memória revisada precisa estar no pacote");
  assert.equal(exported.sources.length, 2, "o pacote carrega TODAS as fontes da memória");
  assert.deepEqual(
    exported.sources.map((source) => source.sourceId).sort(),
    ["chat-message-42", "model:segunda-fonte"],
    "as duas proveniências declaradas saem no pacote",
  );
  assert.equal(exported.versions.length, 1, "o histórico arquivado sai no pacote");
  assert.equal(exported.versions[0]?.content, revised.record.content);
  assert.equal(exported.record.status, "active");

  // Controle positivo do outro lado: o pacote de B devolve só a memória de B.
  const bundleB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.export(bindTransactionContext(requestB, transaction)),
  );
  assert.deepEqual(
    bundleB.memories.map((memory) => memory.record.id),
    [fromB.record.id],
    "o export de B devolve exatamente a memória de B (o de A não é a lista vazia)",
  );

  // Recortes do filtro: camada e escopo restringem o pacote do tenant.
  const onlyL3 = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.export(bindTransactionContext(requestA, transaction), { layers: ["L3"] }),
  );
  assert.deepEqual(
    onlyL3.memories.map((memory) => memory.record.id),
    [revised.record.id],
    "o filtro de camada recorta o pacote",
  );
  const onlyUser = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.export(bindTransactionContext(requestA, transaction), { scopes: ["user"] }),
  );
  assert.deepEqual(
    onlyUser.memories.map((memory) => memory.record.id),
    [personal.record.id],
    "o filtro de escopo recorta o pacote",
  );

  // Exportar é auditado: uma linha por operação, com o tamanho do pacote.
  const logA = await accessLogRows(pool, tenantA);
  assert.deepEqual(
    logA.filter((row) => row.action === "export"),
    [
      { action: "export", result: "allowed", memory_id: null, row_count: 2, user_id: userA },
      { action: "export", result: "allowed", memory_id: null, row_count: 1, user_id: userA },
      { action: "export", result: "allowed", memory_id: null, row_count: 1, user_id: userA },
    ],
    "cada export grava uma linha com o número de memórias do pacote",
  );

  // Identidade sem vínculo com o tenant: a checagem roda ANTES de qualquer
  // consulta de dado e falha alto (INV-013) — não existe "pacote vazio" para
  // quem não tem acesso.
  const forged = { userId: userA, tenantId: tenantB, roles: ["owner"] };
  const logsBefore = await countRows(
    pool,
    "select count(*)::text as count from ai_memory_access_log where tenant_id = $1",
    [tenantB],
  );
  await assert.rejects(
    withRuntimeRoleTransaction(pool, forged, (transaction) =>
      memoryRepository.export(bindTransactionContext({ ...requestA, ...forged }, transaction)),
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof ApplicationError,
        `export sem has_tenant_access deve falhar alto como ApplicationError (recebido: ${String(error)})`,
      );
      assert.equal(error.code, "AUTHORIZATION_ERROR");
      return true;
    },
    "export com identidade sem has_tenant_access deve ser negado antes de qualquer consulta",
  );
  assert.equal(
    await runtimeCount(pool, forged, "ai_memories"),
    0,
    "sob a identidade forjada a RLS não devolve NENHUMA linha de B — sem a checagem explícita o export seria um sucesso vazio (INV-013)",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_access_log where tenant_id = $1",
      [tenantB],
    ),
    logsBefore,
    "a tentativa negada não deixa linha de auditoria em outro tenant",
  );

  console.log(
    "D4/T1 export: conjunto exato do tenant com fontes+versões, recortes por camada/escopo e AUTHORIZATION_ERROR sem has_tenant_access: OK",
  );
}

/**
 * D4/T2 — auditoria e autorização do delete (§43/§15.4, aceite e do gap report):
 * todo delete grava `delete` com o resultado (`allowed`/`not_found`/`refused`),
 * o id de outro tenant é `not_found` sem tocar a linha, memória de escopo
 * pessoal de outro autor é recusada para membro e apagável por owner (controle
 * positivo via `has_tenant_owner_access`), e a trilha é tenant-scoped.
 */
async function d4T2DeleteAuditAndScope(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  // Membro (não-owner) do tenant A, com a própria conversa.
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, 'Memória C', 'memory-c@example.test', true)
     on conflict (id) do nothing`,
    [userC],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'member')
     on conflict (tenant_id, user_id) do nothing`,
    [tenantA, userC],
  );
  const identityC: DatabaseIdentity = { userId: userC, tenantId: tenantA, roles: ["member"] };
  const requestC: RequestIdentity = {
    ...identityC,
    correlationId: "db-test-memory-c",
    signal: new AbortController().signal,
  };

  const tenantScopeMemory = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "Memória do tenant A, apagável por qualquer membro" }),
    ),
  );
  const personalOfA = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ scope: "user", content: "Memória pessoal de A" }),
    ),
  );
  const personalOfC = await withTenantTransaction(identityC, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestC, transaction),
      memoryInput({ scope: "user", content: "Memória pessoal de C" }),
    ),
  );
  const secondPersonalOfC = await withTenantTransaction(identityC, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestC, transaction),
      memoryInput({ scope: "user", content: "Segunda memória pessoal de C (apagada por owner)" }),
    ),
  );
  const fromB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestB, transaction), memoryInput()),
  );

  // 1. Delete legítimo de memória de escopo pessoal PRÓPRIO por membro.
  assert.equal(
    await withTenantTransaction(identityC, (transaction) =>
      memoryRepository.delete(bindTransactionContext(requestC, transaction), personalOfC.record.id),
    ),
    true,
    "o autor de uma memória pessoal pode apagá-la",
  );

  // 2. Membro não apaga memória pessoal de OUTRO autor do mesmo tenant.
  assert.equal(
    await withTenantTransaction(identityC, (transaction) =>
      memoryRepository.delete(bindTransactionContext(requestC, transaction), personalOfA.record.id),
    ),
    false,
    "membro não apaga memória pessoal de outro autor (§43 aceite e)",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where id = $1", [
      personalOfA.record.id,
    ]),
    1,
    "a recusa por escopo não pode apagar a linha",
  );

  // 3. Controle positivo da mesma regra: owner do tenant apaga memória pessoal
  //    de OUTRO autor (has_tenant_owner_access). O membro C é o autor, o owner A
  //    não é — a autorização aqui vem do papel, não da autoria.
  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(
        bindTransactionContext(requestA, transaction),
        secondPersonalOfC.record.id,
      ),
    ),
    true,
    "owner apaga memória pessoal de outro autor do próprio tenant (controle positivo)",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where id = $1", [
      secondPersonalOfC.record.id,
    ]),
    0,
    "a memória pessoal apagada pelo owner sai de verdade",
  );

  // 4. Controle de escopo: a recusa do item 2 é da memória PESSOAL, não um
  //    bloqueio geral — o membro apaga memória de escopo do tenant.
  assert.equal(
    await withTenantTransaction(identityC, (transaction) =>
      memoryRepository.delete(
        bindTransactionContext(requestC, transaction),
        tenantScopeMemory.record.id,
      ),
    ),
    true,
    "membro apaga memória de escopo do tenant (a recusa anterior é do escopo pessoal)",
  );

  // 5. Id de outro tenant: `false` sem erro e a linha de B intacta.
  assert.equal(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.delete(bindTransactionContext(requestA, transaction), fromB.record.id),
    ),
    false,
    "delete de memória de outro tenant devolve false",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where id = $1", [
      fromB.record.id,
    ]),
    1,
    "a memória de B permanece intacta",
  );

  // 6. Idempotência: a 2ª chamada devolve false e ambos ficam auditados.
  const again = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.delete(
      bindTransactionContext(requestA, transaction),
      tenantScopeMemory.record.id,
    ),
  );
  assert.equal(again, false, "a segunda chamada de delete devolve false (idempotente)");

  const logA = await accessLogRows(pool, tenantA);
  const deletes = logA.filter((row) => row.action === "delete");
  assert.deepEqual(
    deletes.map((row) => ({
      result: row.result,
      memoryId: row.memory_id,
      rowCount: row.row_count,
      userId: row.user_id,
    })),
    [
      { result: "allowed", memoryId: personalOfC.record.id, rowCount: 1, userId: userC },
      { result: "refused", memoryId: personalOfA.record.id, rowCount: 0, userId: userC },
      { result: "allowed", memoryId: secondPersonalOfC.record.id, rowCount: 1, userId: userA },
      { result: "allowed", memoryId: tenantScopeMemory.record.id, rowCount: 1, userId: userC },
      { result: "not_found", memoryId: fromB.record.id, rowCount: 0, userId: userA },
      { result: "not_found", memoryId: tenantScopeMemory.record.id, rowCount: 0, userId: userA },
    ],
    "a trilha registra allow/refused/not_found por chamada, com alvo, autor e linhas afetadas",
  );

  // 7. A busca também é auditada, e o log de um tenant não é visível ao outro.
  await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestB, transaction), { text: "relatórios" }),
  );
  const logB = await accessLogRows(pool, tenantB);
  assert.deepEqual(
    logB.map((row) => ({ action: row.action, rowCount: row.row_count, userId: row.user_id })),
    [{ action: "access", rowCount: 1, userId: userB }],
    "o log de B tem só a busca de B",
  );
  assert.equal(
    logB.some((row) => row.user_id === userA || row.user_id === userC),
    false,
    "a trilha é tenant-scoped: nada de A aparece em B",
  );
  assert.equal(
    await runtimeCount(pool, identityA, "ai_memory_access_log"),
    logA.length,
    "sob app_runtime com o GUC de A a trilha de A aparece inteira",
  );
  assert.equal(
    await runtimeCount(pool, identityB, "ai_memory_access_log"),
    logB.length,
    "e com o GUC de B aparece só a de B (RLS, não filtro de aplicação)",
  );

  // 8. A trilha sobrevive ao delete que ela audita e não guarda conteúdo.
  const auditTrail = await pool.query<{ rows: string }>(
    `select count(*)::text as rows from ai_memory_access_log where memory_id = $1`,
    [tenantScopeMemory.record.id],
  );
  assert.equal(
    auditTrail.rows[0]?.rows,
    "2",
    "a memória apagada mantém o rastro (delete allowed + delete not_found da chamada seguinte)",
  );
  const contentLeak = await pool.query<{ leaks: string }>(
    `select count(*)::text as leaks
       from ai_memory_access_log
      where row_to_json(ai_memory_access_log)::text like '%' || $1 || '%'`,
    [tenantScopeMemory.record.content],
  );
  assert.equal(
    contentLeak.rows[0]?.leaks,
    "0",
    "nenhuma linha da trilha contém o conteúdo da memória",
  );

  console.log(
    "D4/T2 auditoria: allow/refused/not_found por chamada, recusa de escopo pessoal com controle positivo, trilha tenant-scoped e sem conteúdo: OK",
  );
}

/**
 * D4/T3 — TTL por camada com expiração IDEMPOTENTE (§23.2, H-12 critérios 1-3):
 * a janela de cada memória vem da policy versionada da sua camada (L1/L2/L3 com
 * TTL, L4/L5 sem); publicar uma versão nova da policy muda a janela das
 * gravações seguintes (prova de que o mecanismo lê dado, não constante); o
 * expirador passa a `expired` só o que venceu, é idempotente, não atravessa
 * tenant, e `search` já não devolve linha vencida. Camada sem policy publicada
 * **falha alta** e não grava nada (INV-013).
 */
async function d4T3TtlByLayer(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  // A política é dado GLOBAL do sistema: o teste republica uma versão nova
  // abaixo, então repõe o estado (versões > 1) antes de medir — o script é
  // reexecutável e o valor medido não depende de uma execução anterior.
  await pool.query("delete from ai_memory_policies where version > 1");

  const ttl = await publishedTtlSeconds(pool);
  assert.deepEqual(
    Object.keys(ttl).sort(),
    ["L1", "L2", "L3", "L4", "L5"],
    "as cinco camadas persistidas precisam de política publicada",
  );
  assert.equal(ttl.L4, null, "L4 acompanha a entidade referenciada (sem TTL de relógio)");
  assert.equal(ttl.L5, null, "L5 é versionada (sem TTL)");
  assert.ok(
    (ttl.L1 ?? 0) > 0 && (ttl.L1 ?? 0) < (ttl.L2 ?? 0) && (ttl.L2 ?? 0) < (ttl.L3 ?? 0),
    "os TTLs precisam crescer de L1 para L3 (minimização: sessão < episódica < semântica)",
  );

  const byLayer = new Map<string, string>();
  for (const layer of ["L1", "L2", "L3", "L4", "L5"] as const) {
    const appended = await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.append(
        bindTransactionContext(requestA, transaction),
        memoryInput({ content: `Memória da camada ${layer}`, layer }),
      ),
    );
    byLayer.set(layer, appended.record.id);
    assert.equal(appended.record.layer, layer, `a camada ${layer} precisa ser persistida`);
    assert.equal(
      await expiryWindowSeconds(pool, appended.record.id),
      layer === "L4" || layer === "L5" ? null : ttl[layer],
      `a janela de ${layer} é o TTL da policy da camada`,
    );
  }
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memories where tenant_id = $1 and expires_at is null",
      [tenantA],
    ),
    2,
    "só L4 e L5 nascem sem `expires_at` (sem expiração)",
  );

  // Camada além das persistidas: a camada é fechada (o CHECK do banco diz o
  // mesmo), então um valor fora do vocabulário é erro do chamador.
  await assert.rejects(
    withTenantTransaction(identityA, (transaction) =>
      memoryRepository.append(
        bindTransactionContext(requestA, transaction),
        memoryInput({ content: "Camada inexistente L0", layer: "L0" as never }),
      ),
    ),
    (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_ERROR",
    "L0 (working) não é persistido: gravar nessa camada falha alto",
  );

  // Publicar uma versão nova da policy (INSERT sob app_runtime, sem DDL) muda a
  // janela das gravações seguintes — o TTL é dado, não constante de código.
  const shorterTtl = 60;
  await withRuntimeRoleTransaction(pool, identityA, (transaction) =>
    transaction.execute(
      sql`insert into ai_memory_policies (layer, version, ttl_seconds)
          values ('L1', 2, ${shorterTtl})`,
    ),
  );
  const republished = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "Memória L1 depois da republicação da policy", layer: "L1" }),
    ),
  );
  assert.equal(
    await expiryWindowSeconds(pool, republished.record.id),
    shorterTtl,
    "a janela passa a ser a da versão mais nova da policy (mecanismo dirigido por dado)",
  );
  assert.equal(
    await expiryWindowSeconds(pool, byLayer.get("L1") as string),
    ttl.L1,
    "a republicação não é retroativa: a memória já gravada mantém a janela antiga",
  );

  // Vencimento: a linha L1 vai para o passado (mesma coluna que o expirador
  // lê) e B ganha uma linha vencida própria — o expirador de A não pode alcançar
  // a de B.
  const expiredInA = byLayer.get("L1") as string;
  await pool.query("update ai_memories set expires_at = now() - interval '1 hour' where id = $1", [
    expiredInA,
  ]);
  const inB = await withTenantTransaction(identityB, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestB, transaction),
      memoryInput({ content: "Memória de B vencida para medir o alcance do expirador" }),
    ),
  );
  await pool.query("update ai_memories set expires_at = now() - interval '1 hour' where id = $1", [
    inB.record.id,
  ]);

  const searchBefore = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.search(bindTransactionContext(requestA, transaction), { text: "Memória" }),
  );
  assert.equal(
    searchBefore.some((record) => record.id === expiredInA),
    false,
    "memória vencida não aparece no retrieval",
  );
  const stillValid = byLayer.get("L2") as string;
  assert.equal(
    searchBefore.some((record) => record.id === stillValid),
    true,
    "controle positivo: a memória dentro do prazo continua aparecendo",
  );

  const expiredByA = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.expireDue(bindTransactionContext(requestA, transaction)),
  );
  assert.deepEqual(
    expiredByA,
    [expiredInA],
    "o expirador afeta exatamente a linha vencida do tenant do contexto",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memories where id = $1 and status = $2",
      [expiredInA, "expired"],
    ),
    1,
    "a linha vencida passa a `expired`",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memories where id = $1 and status = $2",
      [stillValid, "active"],
    ),
    1,
    "a linha dentro do prazo não é tocada",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memories where id = $1 and status = $2",
      [inB.record.id, "active"],
    ),
    1,
    "o expirador de A não alcança a linha de B",
  );

  const idempotent = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.expireDue(bindTransactionContext(requestA, transaction)),
  );
  assert.deepEqual(idempotent, [], "a segunda passada devolve [] (expirador idempotente)");
  assert.deepEqual(
    await withTenantTransaction(identityB, (transaction) =>
      memoryRepository.expireDue(bindTransactionContext(requestB, transaction)),
    ),
    [inB.record.id],
    "controle positivo do outro lado: B expira a própria linha vencida",
  );

  // Expirar é transição de estado, não exclusão: a linha continua exportável.
  const bundleAfterExpiry = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.export(bindTransactionContext(requestA, transaction)),
  );
  const expiredExported = bundleAfterExpiry.memories.find(
    (memory) => memory.record.id === expiredInA,
  );
  assert.equal(
    expiredExported?.record.status,
    "expired",
    "a memória expirada continua no pacote de portabilidade (com o estado correto)",
  );

  // INV-013: sem policy publicada para a camada, o append falha alto e não grava
  // nada — retenção indefinida silenciosa não é sucesso.
  const beforeMissingPolicy = await countRows(
    pool,
    "select count(*)::text as count from ai_memories where tenant_id = $1",
    [tenantA],
  );
  await pool.query("delete from ai_memory_policies where layer = 'L3'");
  try {
    await assert.rejects(
      withTenantTransaction(identityA, (transaction) =>
        memoryRepository.append(
          bindTransactionContext(requestA, transaction),
          memoryInput({ content: "Sem policy de L3 não pode gravar", layer: "L3" }),
        ),
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof ApplicationError,
          `camada sem policy deve falhar alto (recebido: ${String(error)})`,
        );
        assert.equal(error.code, "INTERNAL_ERROR");
        return true;
      },
      "camada sem política publicada falha alto em vez de gravar com TTL indefinido",
    );
  } finally {
    await pool.query(
      `insert into ai_memory_policies (layer, version, ttl_seconds) values ('L3', 1, $1)
       on conflict (layer, version) do nothing`,
      [ttl.L3],
    );
  }
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memories where tenant_id = $1", [
      tenantA,
    ]),
    beforeMissingPolicy,
    "a falha do append sem policy não deixa linha gravada",
  );

  console.log(
    "D4/T3 TTL: janela por camada vinda da policy versionada, expiração idempotente e tenant-scoped, retrieval sem vencida e falha alta sem policy: OK",
  );
}

/**
 * D4/T4 — migration reproduzível do zero e COM DADOS (INV-012): o banco
 * descartável aplica a cadeia inteira (journal 20) e o par 0019 up→down→up
 * roda com memória gravada, preservando o dado (a coluna `layer` volta com o
 * default e `expires_at` volta nula) e revogando o estado `expired` que o down
 * não tem como representar.
 */
async function d4T4MigrationWithData(pool: Pool): Promise<void> {
  await seedFixtures(pool);

  const journal = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations",
  );
  assert.equal(
    journal.rows[0]?.count,
    EXPECTED_JOURNAL_COUNT,
    "a cadeia 0000→0019 precisa estar aplicada do zero no banco descartável",
  );
  const policies = await countRows(
    pool,
    "select count(*)::text as count from ai_memory_policies where version = 1",
  );
  assert.equal(policies, 5, "o seed da 0019 publica as cinco políticas iniciais");

  const before = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(
      bindTransactionContext(requestA, transaction),
      memoryInput({ content: "Memória que precisa sobreviver ao up→down→up da 0019" }),
    ),
  );
  assert.deepEqual(
    await withTenantTransaction(identityA, (transaction) =>
      memoryRepository.expireDue(bindTransactionContext(requestA, transaction)),
    ),
    [],
    "controle prévio: nenhuma linha vencida antes do down",
  );

  const downSql = await readFile(resolve("drizzle/rollback", MEMORY_D4_MIGRATION_DOWN), "utf8");
  const client = await pool.connect();
  try {
    await client.query(downSql);
    await client.query(
      "delete from drizzle.__drizzle_migrations where id in (select id from drizzle.__drizzle_migrations order by id desc limit 1)",
    );
    const gone = await client.query<{ log: string | null; policies: string | null }>(
      `select to_regclass('public.ai_memory_access_log')::text as log,
              to_regclass('public.ai_memory_policies')::text as policies`,
    );
    assert.deepEqual(
      gone.rows[0],
      { log: null, policies: null },
      "o down da 0019 remove a trilha e as políticas",
    );
    const columns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_memories'
          and column_name in ('layer', 'expires_at')`,
    );
    assert.deepEqual(columns.rows, [], "o down remove layer e expires_at de ai_memories");
  } finally {
    client.release();
  }

  await runMigrations(requireAdminUrl());

  const restored = await pool.query<{
    content: string;
    layer: string;
    status: string;
    expires: boolean;
  }>(
    `select content, layer, status, expires_at is null as expires
       from ai_memories where id = $1`,
    [before.record.id],
  );
  assert.deepEqual(
    restored.rows[0],
    {
      content: before.record.content,
      layer: "L2",
      status: "active",
      expires: true,
    },
    "o up de novo re-adiciona as colunas com o default e o dado sobrevive byte a byte no conteúdo",
  );
  assert.equal(
    await countRows(
      pool,
      "select count(*)::text as count from ai_memory_policies where version = 1",
    ),
    5,
    "o seed das políticas volta no segundo up (INSERT idempotente)",
  );
  assert.equal(
    await countRows(pool, "select count(*)::text as count from ai_memory_access_log"),
    0,
    "a trilha recriada começa vazia (o down descarta o rastro; declarado no down)",
  );
  const vocabulary = await pool.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'ai_memories_status_check'`,
  );
  assert.match(
    vocabulary.rows[0]?.definition ?? "",
    /expired/,
    "o vocabulário de estados volta com `expired` depois do segundo up",
  );
  const journalAfter = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations",
  );
  assert.equal(
    journalAfter.rows[0]?.count,
    EXPECTED_JOURNAL_COUNT,
    "o journal volta ao tamanho da cadeia completa",
  );

  console.log(
    "D4/T4 migration: cadeia 20/20 do zero + up→down→up da 0019 com dado preservado e políticas re-semeadas: OK",
  );
}

/** D4/T5 — a migration do degrau está classificada no registry §27a (classe,
 * `appliedOn`, `idempotent` e `onlineCare` declarados) e tem down. */
async function d4T5MigrationClassification(): Promise<void> {
  const result = await classifyProject(process.cwd());
  assert.deepEqual(result.errors, [], "o registry de classes precisa estar sem divergências");
  const entry = result.rows.find((row) => row.tag === MEMORY_D4_MIGRATION_TAG);
  assert.ok(entry, `a migration ${MEMORY_D4_MIGRATION_TAG} precisa estar no journal e no registry`);
  assert.equal(
    entry.class,
    "ONLINE_WITH_CARE",
    "ALTER TABLE com validação de CHECK + DML de seed não são SAFE (§27)",
  );
  assert.equal(entry.appliedOn, "empty");
  assert.equal(entry.ok, true);
  const registry = migrationClasses.find((row) => row.tag === MEMORY_D4_MIGRATION_TAG);
  assert.equal(registry?.idempotent, true, "o seed precisa ser idempotente");
  assert.ok((registry?.onlineCare ?? "").trim().length > 0, "ONLINE_WITH_CARE exige onlineCare");
  assert.equal(
    registry?.sha256,
    computeSha256(await readFile(resolve("drizzle", `${MEMORY_D4_MIGRATION_TAG}.sql`))),
    "o sha256 do registry precisa ser byte a byte o do arquivo",
  );
  await assert.doesNotReject(
    readFile(resolve("drizzle/rollback", MEMORY_D4_MIGRATION_DOWN), "utf8"),
    `o down ${MEMORY_D4_MIGRATION_DOWN} precisa existir`,
  );

  console.log(
    `D4/T5 classificação: ${result.classified}/${result.total} classificadas · ${MEMORY_D4_MIGRATION_TAG} = ONLINE_WITH_CARE/empty + idempotent + down: OK`,
  );
}

/**
 * D4/T6 — privilégio da trilha e das políticas (§34/INV-010): a trilha é
 * append-only **medida** (UPDATE/DELETE negados sob `app_runtime`), o `WITH
 * CHECK` recusa linha forjada de outro tenant, o vocabulário de ações é fechado
 * e as políticas são SELECT+INSERT sem RLS (tabela global de configuração).
 */
async function d4T6AuditPrivileges(pool: Pool): Promise<void> {
  await seedFixtures(pool);
  const appended = await withTenantTransaction(identityA, (transaction) =>
    memoryRepository.append(bindTransactionContext(requestA, transaction), memoryInput()),
  );
  await withRuntimeRoleTransaction(pool, identityA, (transaction) =>
    memoryRepository.delete(bindTransactionContext(requestA, transaction), appended.record.id),
  );

  await expectRuntimeDenial(
    pool,
    identityA,
    "42501",
    (transaction) => transaction.execute(sql`update ai_memory_access_log set result = 'allowed'`),
    "UPDATE na trilha de auditoria deve ser negado por privilégio (42501)",
  );
  await expectRuntimeDenial(
    pool,
    identityA,
    "42501",
    (transaction) => transaction.execute(sql`delete from ai_memory_access_log`),
    "DELETE na trilha de auditoria deve ser negado por privilégio (42501)",
  );
  await expectRuntimeDenial(
    pool,
    identityA,
    "42501",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memory_access_log (tenant_id, user_id, action, result, row_count)
            values (${tenantB}, ${userA}, 'access', 'allowed', 0)`,
      ),
    "linha de trilha forjando o tenant de B sob o GUC de A deve violar o WITH CHECK (42501)",
  );
  await expectRuntimeDenial(
    pool,
    identityA,
    "23514",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memory_access_log (tenant_id, user_id, action, result, row_count)
            values (${tenantA}, ${userA}, 'expire', 'allowed', 0)`,
      ),
    "ação fora de access/delete/export deve ser recusada pelo CHECK (23514)",
  );
  await expectRuntimeDenial(
    pool,
    identityA,
    "23514",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memory_access_log (tenant_id, user_id, action, result, row_count)
            values (${tenantA}, ${userA}, 'delete', 'maybe', 0)`,
      ),
    "resultado fora de allowed/not_found/refused deve ser recusado pelo CHECK (23514)",
  );
  await expectRuntimeDenial(
    pool,
    identityA,
    "23514",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memory_policies (layer, version, ttl_seconds) values ('L0', 1, 10)`,
      ),
    "camada fora de L1..L5 deve ser recusada pelo CHECK das políticas (23514)",
  );
  await expectRuntimeDenial(
    pool,
    identityA,
    "23514",
    (transaction) =>
      transaction.execute(
        sql`insert into ai_memory_policies (layer, version, ttl_seconds) values ('L1', 900, 0)`,
      ),
    "TTL zero deve ser recusado pelo CHECK das políticas (23514)",
  );

  const metadata = await pool.query<{
    table_name: string;
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
    publicSelect: boolean;
    policies: string;
  }>(
    `select c.relname as table_name,
            c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'select') as "select",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'insert') as "insert",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'update') as "update",
            has_table_privilege('app_runtime', 'public.' || c.relname, 'delete') as "delete",
            has_table_privilege('public', 'public.' || c.relname, 'select') as "publicSelect",
            coalesce((select string_agg(p.policyname || ':' || coalesce(p.qual, '-') || ':' || coalesce(p.with_check, '-'), '|')
               from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname), '') as "policies"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('ai_memory_access_log', 'ai_memory_policies')
      order by c.relname`,
  );
  assert.deepEqual(
    metadata.rows.map((row) => ({
      table: row.table_name,
      rls: row.rowSecurity,
      sel: row.select,
      ins: row.insert,
      upd: row.update,
      del: row.delete,
      pub: row.publicSelect,
    })),
    [
      {
        table: "ai_memory_access_log",
        rls: true,
        sel: true,
        ins: true,
        upd: false,
        del: false,
        pub: false,
      },
      {
        table: "ai_memory_policies",
        rls: false,
        sel: true,
        ins: true,
        upd: false,
        del: false,
        pub: false,
      },
    ],
    "trilha append-only com RLS; políticas globais com SELECT/INSERT e sem RLS; nada para PUBLIC",
  );
  assert.match(
    metadata.rows[0]?.policies ?? "",
    /^tenant_isolation:.*current_tenant_id.*has_tenant_access.*:.*current_tenant_id.*has_tenant_access.*$/,
    "a policy da trilha precisa ter USING e WITH CHECK com has_tenant_access",
  );

  const columns = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'ai_memory_access_log'
      order by column_name`,
  );
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    ["action", "created_at", "id", "memory_id", "result", "row_count", "tenant_id", "user_id"],
    "a trilha não tem coluna de conteúdo nem de consulta (o log não é superfície de dado pessoal)",
  );

  console.log(
    "D4/T6 privilégios: trilha append-only medida (42501), WITH CHECK e CHECKs de vocabulário, políticas globais com SELECT+INSERT: OK",
  );
}

async function main(): Promise<void> {
  const adminUrl = requireAdminUrl();
  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const database = drizzle({ client: pool, schema });
  setDatabaseForTests(database as unknown as Database);

  try {
    await runMigrations(adminUrl);
    await ensureRuntimeRoleMembership(pool);
    await t1TenantIsolation(pool);
    await t2Provenance(pool);
    await t3AtomicWithDomainEffect(pool);
    await t4Delete(pool);
    await t5MigrationClassification();
    await d3T1DedupIdempotent(pool);
    await d3T2Revision(pool);
    await d3T3Conflict(pool);
    await d3T4DeleteWithHistory(pool);
    await d3T5ConcurrentAppend(pool);
    await d3T6DedupTenantIsolation(pool);
    await d3T7VersionImmutability(pool);
    await d3T8MigrationClassification();
    await d3T9ReviseKeyCollision(pool);
    await d4T1ExportTenantIsolation(pool);
    await d4T2DeleteAuditAndScope(pool);
    await d4T3TtlByLayer(pool);
    await d4T6AuditPrivileges(pool);
    await d4T5MigrationClassification();
    await d4T4MigrationWithData(pool);
  } finally {
    setDatabaseForTests(undefined);
    await pool.end();
  }

  console.log(
    "Memória §43/D2+D3+D4 (persistência, proveniência, tenant, dedup, versões, conflitos, delete/export, TTL): OK",
  );
}

await main();
