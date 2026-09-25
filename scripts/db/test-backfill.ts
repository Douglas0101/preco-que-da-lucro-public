/**
 * §28 — integração real do runner de backfill contra o banco descartável (PG17).
 *
 * O ledger (checkpoint + marcador de idempotência) é **schema-managed** desde o
 * WP-1a: `backfill_checkpoints`/`backfill_work_items` vêm da migration gerada
 * (com grants e RLS por tenant) e este script NÃO cria DDL de ledger. A fixture
 * `backfill_demo_rows` é local — nenhuma tabela de produção é alterada.
 *
 * Testes:
 *   T1  SIGKILL de verdade no meio do run (processo filho) ⇒ a retomada relê o
 *       lote interrompido inteiro, sem pular nem replicar (`max_apply_count = 1`),
 *       com o checkpoint parado no último lote fechado.
 *   T2  contenção CAS: dois workers no MESMO `runKey` ⇒ exatamente 1 avança e o
 *       outro recebe conflito explícito (`BackfillCheckpointConflictError`), sem
 *       inflar contadores nem reaplicar efeito.
 *   T3  erro real do servidor (SQLSTATE 22012) no meio do lote ⇒ checkpoint
 *       estável no lote anterior e marcador da linha que falhou ausente (o
 *       marcador cai na MESMA transação do efeito).
 *   T4  idempotência: 2ª tentativa completa (checkpoint novo, mesma `workKey`)
 *       ⇒ 0 efeitos novos e estado idêntico.
 *   T5  RLS/grants: sob `app_runtime` (NOSUPERUSER/NOBYPASSRLS) o ledger de outro
 *       tenant é invisível e a escrita cruzada é recusada pela policy.
 *
 * Tempo: o caso com `rateLimit` (T1) injeta **relógio virtual** (`now`/`sleep`)
 * — a janela pertence ao teste, não à latência do host, então `esperas` é
 * determinístico; nele, `taxa`/`duração` do lote são virtuais. Os demais casos
 * usam o relógio real e reportam medição de verdade.
 *
 * Uso:
 *   npx tsx scripts/db/test-backfill.ts                 # narrativa T1..T5
 *   npx tsx scripts/db/test-backfill.ts --phase=crash    # filho (morre no meio)
 *   npx tsx scripts/db/test-backfill.ts --phase=teardown # remove as fixtures daqui
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  BackfillAbortedError,
  BackfillCheckpointConflictError,
  createBackfillRunner,
  type BackfillCheckpointStore,
  type BackfillProgressEvent,
  type BackfillRunSummary,
  type BackfillSink,
  type BackfillSource,
} from "./backfill-runner";
import { applyWorkItemOnce, createPostgresCheckpointStore } from "./backfill-ledger";
import { requireAdminUrl, runMigrations } from "./migrate";
import { MEMORY_TRAIL_TABLES } from "./purge-fixtures";

const WORK_KEY = "backfill-demo.derived_amount:v1";
const MAIN_RUN_KEY = "backfill-demo:attempt-1";
const VERIFY_RUN_KEY = "backfill-demo:attempt-2";
const POISON_RUN_KEY = "backfill-demo:poison-attempt-1";
const CONTENTION_RUN_KEY = "backfill-demo:contention";
const BATCH_SIZE = 3;
const RATE_LIMIT = { maxRows: 4, windowMs: 50 };
const CRASH_AFTER_ROW = 4;

// Tenants de laboratório exigidos pela FK do ledger (o ledger é tenant-scoped).
const USER_A = "b1000000-0000-4000-8000-0000000000a1";
const TENANT_A = "b2000000-0000-4000-8000-0000000000a2";
const USER_B = "b1000000-0000-4000-8000-0000000000b1";
const TENANT_B = "b2000000-0000-4000-8000-0000000000b2";

const FIXTURE_DDL = `
drop table if exists backfill_demo_rows;
create table backfill_demo_rows (
  id text primary key,
  amount numeric(12,2) not null,
  derived_amount numeric(12,2),
  apply_count integer not null default 0,
  poison boolean not null default false
);
`;

interface DemoRow {
  id: string;
  amount: string;
  poison: boolean;
}

interface FixtureState {
  rows: number;
  derived: number;
  maxApplies: number;
  duplicated: number;
  workItems: number;
  checkpoint: string;
}

function rowId(index: number): string {
  return `d${String(index).padStart(2, "0")}`;
}

/** O driver embrulha o erro do servidor; o SQLSTATE vive na cadeia de causas. */
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

async function seedTenants(pool: Pool): Promise<void> {
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, 'Backfill A', 'backfill-a@example.test', true),
            ($2, 'Backfill B', 'backfill-b@example.test', true)
     on conflict (id) do nothing`,
    [USER_A, USER_B],
  );
  await pool.query(
    `insert into tenants (id, name, slug)
     values ($1, 'Backfill Tenant A', 'backfill-tenant-a'),
            ($2, 'Backfill Tenant B', 'backfill-tenant-b')
     on conflict (id) do nothing`,
    [TENANT_A, TENANT_B],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role)
     values ($1, $2, 'owner'), ($3, $4, 'owner')
     on conflict (tenant_id, user_id) do nothing`,
    [TENANT_A, USER_A, TENANT_B, USER_B],
  );
}

/** Zera fixtures e o ledger do tenant A e semeia `count` linhas (opcionalmente uma venenosa). */
async function seed(pool: Pool, count: number, options: { poisonAt?: number } = {}): Promise<void> {
  await pool.query("delete from backfill_demo_rows");
  await pool.query("delete from backfill_work_items where tenant_id = $1", [TENANT_A]);
  await pool.query("delete from backfill_checkpoints where tenant_id = $1", [TENANT_A]);
  for (let index = 1; index <= count; index += 1) {
    await pool.query(`insert into backfill_demo_rows (id, amount, poison) values ($1, $2, $3)`, [
      rowId(index),
      (100 + index * 10).toFixed(2),
      options.poisonAt === index,
    ]);
  }
}

function demoSource(pool: Pool): BackfillSource<DemoRow> {
  return {
    fetchChunk: async ({ cursor, batchSize }) => {
      const result = await pool.query<DemoRow>(
        `select id, amount, poison from backfill_demo_rows
         where ($1::text is null or id > $1)
         order by id
         limit $2`,
        [cursor, batchSize],
      );
      return result.rows;
    },
  };
}

/** Efeito transacional com o marcador (`applyWorkItemOnce`): grava 1× por linha. */
function demoEffectSink(
  pool: Pool,
  hooks: { afterProcessed?: (processed: number) => void } = {},
): BackfillSink<DemoRow> {
  let processed = 0;
  return {
    apply: async (row, context) => {
      const outcome = await applyWorkItemOnce(pool, {
        tenantId: TENANT_A,
        workKey: context.workKey,
        runKey: context.runKey,
        rowKey: context.rowKey,
        effect: async (client) => {
          // Erro de servidor de verdade na linha envenenada (SQLSTATE 22012).
          if (row.poison) await client.query("select 1 / $1::int", [0]);
          await client.query(
            `update backfill_demo_rows
             set derived_amount = round(amount * 1.2, 2), apply_count = apply_count + 1
             where id = $1`,
            [row.id],
          );
        },
      });
      processed += 1;
      hooks.afterProcessed?.(processed);
      return outcome;
    },
  };
}

function printProgress(event: BackfillProgressEvent): void {
  console.log(
    `    [${event.type} lote ${event.batch}] linhas=${event.rows} lidas=${event.rowsScanned} ` +
      `aplicadas=${event.rowsApplied} duplicadas=${event.rowsDuplicate} erros=${event.errors} ` +
      `cursor=${event.cursor ?? "-"} versão=${event.checkpoint.version} ` +
      `taxa=${event.rowsPerSecond.toFixed(1)}/s ` +
      `checkpoint=${event.checkpoint.completed ? "concluído" : "em curso"}`,
  );
}

function printSummary(label: string, summary: BackfillRunSummary): void {
  console.log(
    `  ${label}: lotes=${summary.batches} lidas=${summary.rowsScanned} aplicadas=${summary.rowsApplied} ` +
      `duplicadas=${summary.rowsDuplicate} erros=${summary.errors} taxa=${summary.rowsPerSecond.toFixed(1)}/s ` +
      `esperas=${summary.rateLimitWaits}(${summary.rateLimitWaitMs}ms) checkpoint=${summary.checkpoint.cursor}/${summary.checkpoint.completed ? "concluído" : "em curso"} ` +
      `versão=${summary.checkpoint.version} retomada=${summary.resumed} duração=${summary.durationMs}ms`,
  );
}

/**
 * Relógio virtual do rate-limit: a janela pertence ao TESTE, não à latência do
 * banco. `sleep` avança o relógio sem dormir de verdade, então a espera é
 * determinística — medir a janela com tempo real fazia a asserção de T1 oscilar
 * (0 ou 1 espera) conforme a máquina, que é flake, não gate.
 */
function virtualClock(start = Date.now()) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
  };
}

function buildRunner(
  pool: Pool,
  options: {
    runKey: string;
    batchSize: number;
    crashAfter?: number;
    rateLimit?: { maxRows: number; windowMs: number };
    onProgress?: (event: BackfillProgressEvent) => void;
    checkpoints?: BackfillCheckpointStore;
  },
) {
  // Relógio virtual SÓ onde há janela de rate-limit (a espera é do teste, não da
  // latência do host); nos casos sem janela o tempo real continua sendo o
  // reportado (a taxa/duração de T2–T4 segue sendo medição de verdade).
  const clock = options.rateLimit ? virtualClock() : null;
  return createBackfillRunner<DemoRow>({
    workKey: WORK_KEY,
    runKey: options.runKey,
    batchSize: options.batchSize,
    keyOf: (row) => row.id,
    source: demoSource(pool),
    sink: demoEffectSink(pool, {
      afterProcessed: (processed) => {
        if (options.crashAfter === processed) process.kill(process.pid, "SIGKILL");
      },
    }),
    checkpoints: options.checkpoints ?? createPostgresCheckpointStore(pool, { tenantId: TENANT_A }),
    rateLimit: options.rateLimit,
    onProgress: options.onProgress ?? printProgress,
    ...(clock ? { now: clock.now, sleep: clock.sleep } : {}),
  });
}

async function readState(pool: Pool, runKey: string): Promise<FixtureState> {
  const rows = await pool.query<{
    rows: number;
    derived: number;
    max_applies: number;
    duplicated: number;
  }>(
    `select count(*)::int as rows,
            count(derived_amount)::int as derived,
            coalesce(max(apply_count), 0)::int as max_applies,
            count(*) filter (where apply_count > 1)::int as duplicated
     from backfill_demo_rows`,
  );
  const items = await pool.query<{ items: number }>(
    `select count(*)::int as items from backfill_work_items
     where tenant_id = $1 and work_key like $2`,
    [TENANT_A, `${WORK_KEY}#%`],
  );
  const checkpoint = await pool.query<{
    cursor: string | null;
    completed: boolean;
    batches: number;
    rows_scanned: number;
    rows_applied: number;
    rows_duplicate: number;
    errors: number;
    version: number;
  }>(
    `select cursor, completed, batches, rows_scanned, rows_applied, rows_duplicate, errors, version
     from backfill_checkpoints where tenant_id = $1 and run_key = $2`,
    [TENANT_A, runKey],
  );
  const row = rows.rows[0];
  const cp = checkpoint.rows[0];
  return {
    rows: row.rows,
    derived: row.derived,
    maxApplies: row.max_applies,
    duplicated: row.duplicated,
    workItems: items.rows[0].items,
    checkpoint: cp
      ? `${cp.cursor ?? "-"}/lotes=${cp.batches}/lidas=${cp.rows_scanned}/aplicadas=${cp.rows_applied}/dup=${cp.rows_duplicate}/erros=${cp.errors}/v=${cp.version}/${cp.completed ? "concluído" : "em curso"}`
      : "ausente",
  };
}

async function printState(pool: Pool, label: string, runKey: string): Promise<void> {
  const state = await readState(pool, runKey);
  console.log(
    `  estado (${label}): linhas=${state.rows} derivadas=${state.derived} max_apply_count=${state.maxApplies} ` +
      `linhas_duplicadas=${state.duplicated} marcadores=${state.workItems} checkpoint=${state.checkpoint}`,
  );
}

/** Deriva a coluna de uma linha só (o efeito) — usado pelo filho do SIGKILL. */
async function crashPhase(): Promise<void> {
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 2 });
  try {
    console.log(
      `  [filho] run ${MAIN_RUN_KEY} batchSize=${BATCH_SIZE} · SIGKILL após processar a linha ${CRASH_AFTER_ROW}`,
    );
    await buildRunner(pool, {
      runKey: MAIN_RUN_KEY,
      batchSize: BATCH_SIZE,
      crashAfter: CRASH_AFTER_ROW,
      rateLimit: RATE_LIMIT,
    }).run();
    throw new Error("o run deveria ter morrido por SIGKILL");
  } finally {
    await pool.end();
  }
}

/** T1 — SIGKILL de verdade no meio do run; a retomada não pula nem replica. */
async function t1CrashAndResume(pool: Pool): Promise<void> {
  console.log(
    `\n== T1 — SIGKILL no meio do run (10 linhas, batchSize=${BATCH_SIZE}, rate-limit ${RATE_LIMIT.maxRows}/${RATE_LIMIT.windowMs}ms) ==`,
  );
  await seed(pool, 10);
  await printState(pool, "antes", MAIN_RUN_KEY);

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--phase=crash"],
    { env: process.env, stdio: "inherit" },
  );
  console.log(
    `  [pai] filho: status=${child.status} signal=${child.signal} (morte real no meio do run)`,
  );
  assert.equal(child.signal, "SIGKILL", "o run precisa ter morrido por SIGKILL");
  assert.equal(child.status, null);

  await printState(pool, "após o SIGKILL", MAIN_RUN_KEY);
  const crashed = await readState(pool, MAIN_RUN_KEY);
  assert.equal(crashed.derived, 4, "d04 foi aplicado (transação própria) antes da morte");
  assert.equal(crashed.workItems, 4);
  assert.equal(crashed.checkpoint.startsWith("d03/"), true, "checkpoint no último lote fechado");

  console.log("  -- retomada (mesmo runKey) --");
  const resumed = await buildRunner(pool, {
    runKey: MAIN_RUN_KEY,
    batchSize: BATCH_SIZE,
    rateLimit: RATE_LIMIT,
  }).run();
  printSummary("retomada", resumed);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.rowsScanned, 7, "relê d04..d10 (o lote interrompido inteiro)");
  assert.equal(resumed.rowsDuplicate, 1, "d04 volta como duplicata, não é reaplicada");
  assert.equal(resumed.rowsApplied, 6);
  assert.equal(resumed.errors, 0);
  assert.equal(resumed.rateLimitWaits, 1, "7 linhas em janelas de 4 ⇒ 1 espera");
  assert.equal(
    resumed.rateLimitWaitMs,
    RATE_LIMIT.windowMs,
    "com relógio virtual a espera é a janela cheia (sem depender da latência do banco)",
  );
  assert.equal(resumed.completed, true);
  assert.equal(resumed.checkpoint.cursor, "d10");
  assert.equal(resumed.checkpoint.batches, 4, "lotes do runKey somam os dois runs (2 + 2)");
  const afterResume = await readState(pool, MAIN_RUN_KEY);
  await printState(pool, "após a retomada", MAIN_RUN_KEY);
  assert.equal(afterResume.derived, 10);
  assert.equal(afterResume.maxApplies, 1);
  assert.equal(afterResume.duplicated, 0);
  assert.equal(afterResume.workItems, 10);
}

/** T4 — 2ª tentativa completa: checkpoint novo, mesma `workKey` ⇒ 0 efeitos novos. */
async function t4SecondAttemptIdempotent(pool: Pool): Promise<void> {
  console.log("  -- T4: 2ª tentativa completa (checkpoint novo, mesma workKey) --");
  const verify = await buildRunner(pool, {
    runKey: VERIFY_RUN_KEY,
    batchSize: BATCH_SIZE,
    rateLimit: RATE_LIMIT,
  }).run();
  printSummary("2ª tentativa", verify);
  assert.equal(verify.resumed, false);
  assert.equal(verify.rowsScanned, 10);
  assert.equal(verify.rowsApplied, 0, "nada é reaplicado: a workKey é da linha, não da tentativa");
  assert.equal(verify.rowsDuplicate, 10);
  assert.equal(verify.completed, true);
  const afterVerify = await readState(pool, VERIFY_RUN_KEY);
  await printState(pool, "após a 2ª tentativa", VERIFY_RUN_KEY);
  assert.deepEqual(
    {
      derived: afterVerify.derived,
      maxApplies: afterVerify.maxApplies,
      duplicated: afterVerify.duplicated,
    },
    { derived: 10, maxApplies: 1, duplicated: 0 },
    "rodar 2× não muda o estado",
  );

  const wrong = await pool.query<{ wrong: number }>(
    `select count(*)::int as wrong from backfill_demo_rows
     where derived_amount is distinct from round(amount * 1.2, 2)`,
  );
  assert.equal(wrong.rows[0].wrong, 0, "toda linha derivada corretamente");
}

/** T3 — falha real do servidor no meio do lote: aborta, checkpoint atrasa, retoma. */
async function t3PoisonAbortsBatch(pool: Pool): Promise<void> {
  console.log(
    "\n== T3 — erro real do Postgres (22012) no meio do lote: aborta, checkpoint no lote anterior, retoma ==",
  );
  await seed(pool, 4, { poisonAt: 4 });
  await printState(pool, "antes", POISON_RUN_KEY);

  const failure = await buildRunner(pool, { runKey: POISON_RUN_KEY, batchSize: 2 })
    .run()
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(failure instanceof BackfillAbortedError, "22012 deve abortar o run");
  assert.ok(isPostgresError(failure.cause, "22012"), "a causa precisa ser o erro do servidor");
  printSummary("abortado", failure.summary);
  assert.equal(failure.summary.errors, 1);
  assert.equal(failure.summary.rowsApplied, 3);
  assert.equal(failure.summary.checkpoint.cursor, "d02");
  await printState(pool, "após o abort", POISON_RUN_KEY);
  const afterAbort = await readState(pool, POISON_RUN_KEY);
  assert.equal(afterAbort.derived, 3, "d03 foi aplicado antes da falha");
  assert.equal(afterAbort.workItems, 3, "marcador de d03 sobrevive (efeito commitado)");
  assert.equal(afterAbort.duplicated, 0);
  const orphan = await pool.query<{ items: number }>(
    `select count(*)::int as items from backfill_work_items where tenant_id = $1 and row_key = 'd04'`,
    [TENANT_A],
  );
  assert.equal(orphan.rows[0].items, 0, "marcador e efeito falho caem na MESMA transação");

  await pool.query("update backfill_demo_rows set poison = false where id = 'd04'");
  const resumed = await buildRunner(pool, { runKey: POISON_RUN_KEY, batchSize: 2 }).run();
  printSummary("retomada", resumed);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.rowsScanned, 2, "retoma relendo o lote inteiro (d03, d04)");
  assert.equal(resumed.rowsDuplicate, 1);
  assert.equal(resumed.rowsApplied, 1);
  assert.equal(resumed.completed, true);
  const final = await readState(pool, POISON_RUN_KEY);
  await printState(pool, "final", POISON_RUN_KEY);
  assert.equal(final.derived, 4);
  assert.equal(final.maxApplies, 1, "nenhuma linha recebeu o efeito duas vezes");
  assert.equal(final.duplicated, 0);
  assert.equal(final.workItems, 4);
}

/** Barreira de arranque: libera quando todos os workers chegam. */
function startBarrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release?.();
    await ready;
  };
}

/**
 * Só deixa o worker passar do `load` quando os dois leram a MESMA versão
 * persistida. Sem a barreira, o segundo worker poderia simplesmente retomar o
 * checkpoint do primeiro (caminho seguro, mas não a corrida que T2 prova).
 */
function gatedStore(
  store: BackfillCheckpointStore,
  gate: () => Promise<void>,
): BackfillCheckpointStore {
  return {
    load: async (runKey) => {
      const checkpoint = await store.load(runKey);
      await gate();
      return checkpoint;
    },
    save: (runKey, checkpoint) => store.save(runKey, checkpoint),
  };
}

/** T2 — contenção CAS: dois workers no mesmo `runKey` ⇒ exatamente 1 avança. */
async function t2CasContention(pool: Pool): Promise<void> {
  console.log("\n== T2 — contenção CAS: 2 workers no mesmo runKey (mesma versão de partida) ==");
  await seed(pool, 10);
  const store = createPostgresCheckpointStore(pool, { tenantId: TENANT_A });
  const gate = startBarrier(2);

  const results = await Promise.allSettled(
    [1, 2].map((worker) =>
      buildRunner(pool, {
        runKey: CONTENTION_RUN_KEY,
        batchSize: BATCH_SIZE,
        checkpoints: gatedStore(store, gate),
        onProgress: (event) =>
          console.log(
            `    [worker ${worker} lote ${event.batch}] lidas=${event.rowsScanned} ` +
              `aplicadas=${event.rowsApplied} duplicadas=${event.rowsDuplicate} v=${event.checkpoint.version}`,
          ),
      }).run(),
    ),
  );

  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1, "exatamente 1 worker pode avançar o checkpoint");
  assert.equal(losers.length, 1);
  const loser = losers[0] as PromiseRejectedResult;
  assert.ok(
    loser.reason instanceof BackfillCheckpointConflictError,
    `o perdedor precisa receber conflito explícito (recebido: ${String(loser.reason)})`,
  );
  console.log(`  perdedor: ${loser.reason.message}`);

  const winner = (winners[0] as PromiseFulfilledResult<BackfillRunSummary>).value;
  printSummary("vencedor", winner);
  assert.equal(winner.completed, true, "quem avança termina o trabalho");
  assert.equal(winner.checkpoint.cursor, "d10");
  assert.equal(winner.checkpoint.batches, 4, "só os lotes do vencedor entram no checkpoint");

  const state = await readState(pool, CONTENTION_RUN_KEY);
  await printState(pool, "após a contenção", CONTENTION_RUN_KEY);
  assert.equal(state.derived, 10);
  assert.equal(state.maxApplies, 1, "o efeito acontece uma vez por linha, mesmo com 2 workers");
  assert.equal(state.duplicated, 0);
  assert.equal(state.workItems, 10);

  const row = await pool.query<{
    cursor: string | null;
    completed: boolean;
    batches: number;
    scanned: number;
    applied: number;
    duplicate: number;
    version: number;
  }>(
    `select cursor, completed, batches, rows_scanned as scanned,
            rows_applied as applied, rows_duplicate as duplicate, version
     from backfill_checkpoints where tenant_id = $1 and run_key = $2`,
    [TENANT_A, CONTENTION_RUN_KEY],
  );
  const checkpoint = row.rows[0];
  // O checkpoint persistido é o do vencedor: só os lotes dele (4), só as linhas
  // que ele leu (10) e o CAS andou exatamente 4 vezes (versão 4).
  assert.equal(checkpoint.cursor, "d10");
  assert.equal(checkpoint.completed, true);
  assert.equal(checkpoint.batches, 4, "os lotes do perdedor não inflam o checkpoint");
  assert.equal(checkpoint.scanned, 10, "as linhas lidas pelo perdedor não inflam o checkpoint");
  assert.equal(checkpoint.version, 4);
  assert.equal(
    checkpoint.applied + checkpoint.duplicate,
    10,
    "aplicadas + duplicadas fecham com as linhas lidas (nada é contado 2×)",
  );
  console.log(
    `  checkpoint do vencedor: aplicadas=${checkpoint.applied} duplicadas=${checkpoint.duplicate} (repartição depende da corrida)`,
  );
}

/** T5 — RLS/grants: o ledger é tenant-scoped e fail-closed sob `app_runtime`. */
async function t5TenantIsolation(pool: Pool): Promise<void> {
  console.log("\n== T5 — RLS/grants do ledger sob app_runtime (NOSUPERUSER/NOBYPASSRLS) ==");
  await pool.query(
    `insert into backfill_checkpoints
       (tenant_id, run_key, cursor, completed, batches, rows_scanned, rows_applied, rows_duplicate, errors, version, updated_at)
     values ($1, 't5:tenant-b', 'b01', true, 1, 1, 1, 0, 0, 2, now())
     on conflict (tenant_id, run_key) do nothing`,
    [TENANT_B],
  );
  await pool.query(
    `insert into backfill_work_items (tenant_id, work_key, run_key, row_key)
     values ($1, 't5:tenant-b#b01', 't5:tenant-b', 'b01')
     on conflict (tenant_id, work_key) do nothing`,
    [TENANT_B],
  );
  await pool.query(
    `insert into backfill_checkpoints
       (tenant_id, run_key, cursor, completed, batches, rows_scanned, rows_applied, rows_duplicate, errors, version, updated_at)
     values ($1, 't5:tenant-a', 'a01', true, 1, 1, 1, 0, 0, 2, now())
     on conflict (tenant_id, run_key) do nothing`,
    [TENANT_A],
  );
  await pool.query(
    `insert into backfill_work_items (tenant_id, work_key, run_key, row_key)
     values ($1, 't5:tenant-a#a01', 't5:tenant-a', 'a01')
     on conflict (tenant_id, work_key) do nothing`,
    [TENANT_A],
  );

  const metadata = await pool.query<{
    table_name: string;
    rowSecurity: boolean;
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
    publicInsert: boolean;
  }>(
    `select c.relname as table_name,
            c.relrowsecurity as "rowSecurity",
            has_table_privilege('app_runtime', c.oid, 'select') as "select",
            has_table_privilege('app_runtime', c.oid, 'insert') as "insert",
            has_table_privilege('app_runtime', c.oid, 'update') as "update",
            has_table_privilege('app_runtime', c.oid, 'delete') as "delete",
            has_table_privilege('public', c.oid, 'insert') as "publicInsert"
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in ('backfill_checkpoints', 'backfill_work_items')
     order by c.relname`,
  );
  assert.deepEqual(
    metadata.rows,
    [
      {
        table_name: "backfill_checkpoints",
        rowSecurity: true,
        select: true,
        insert: true,
        update: true,
        delete: false,
        publicInsert: false,
      },
      {
        table_name: "backfill_work_items",
        rowSecurity: true,
        select: true,
        insert: true,
        update: false,
        delete: false,
        publicInsert: false,
      },
    ],
    "o ledger só existe para app_runtime com RLS habilitado (SELECT/INSERT/UPDATE; nunca DELETE)",
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
  try {
    await client.query("begin");
    await client.query("set local role app_runtime");
    await client.query("select set_config('app.current_user_id', $1, true)", [USER_A]);
    await client.query("select set_config('app.current_tenant_id', $1, true)", [TENANT_A]);

    const own = await client.query<{ n: number }>(
      `select count(*)::int as n from backfill_checkpoints where run_key like 't5:%'`,
    );
    assert.equal(own.rows[0].n, 1, "A deve enxergar o próprio checkpoint de T5");
    const ownItems = await client.query<{ n: number }>(
      `select count(*)::int as n from backfill_work_items where work_key like 't5:%'`,
    );
    assert.equal(ownItems.rows[0].n, 1, "A deve enxergar o próprio marcador de T5");
    const foreignCheckpoint = await client.query<{ n: number }>(
      `select count(*)::int as n from backfill_checkpoints where run_key = 't5:tenant-b'`,
    );
    assert.equal(foreignCheckpoint.rows[0].n, 0, "o checkpoint de B deve ser invisível para A");
    const foreignItems = await client.query<{ n: number }>(
      `select count(*)::int as n from backfill_work_items where tenant_id = $1`,
      [TENANT_B],
    );
    assert.equal(foreignItems.rows[0].n, 0, "os marcadores de B devem ser invisíveis para A");

    // A policy precisa ser PERMISSIVA para o dono (não só fail-closed): a
    // escrita legítima passa pelo WITH CHECK.
    const legit = await client.query(
      `insert into backfill_work_items (tenant_id, work_key, run_key, row_key)
       values ($1, 't5:tenant-a#a02', 't5:tenant-a', 'a02')`,
      [TENANT_A],
    );
    assert.equal(legit.rowCount, 1, "A deve conseguir gravar o próprio marcador");

    // O checkpoint de B é invisível, então o UPDATE não alcança linha alguma
    // (USING filtra antes do WITH CHECK) — nada é sobrescrito em silêncio.
    const foreignUpdate = await client.query(
      `update backfill_checkpoints set cursor = 'x' where run_key = 't5:tenant-b'`,
    );
    assert.equal(foreignUpdate.rowCount, 0, "A não pode tocar o checkpoint de B");

    await assert.rejects(
      client.query(
        `insert into backfill_work_items (tenant_id, work_key, run_key, row_key)
         values ($1, 't5:cross', 't5:cross', 'x01')`,
        [TENANT_B],
      ),
      (error: unknown) => isPostgresError(error, "42501"),
      "marcador com tenant alheio ao GUC deve ser recusado pela policy (WITH CHECK)",
    );
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  console.log("T5 isolamento: RLS por tenant no ledger + WITH CHECK da escrita cruzada: OK");
}

async function fullStory(): Promise<void> {
  await runMigrations();
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 4 });
  try {
    await pool.query(FIXTURE_DDL);
    await seedTenants(pool);
    await t1CrashAndResume(pool);
    await t4SecondAttemptIdempotent(pool);
    await t3PoisonAbortsBatch(pool);
    await t2CasContention(pool);
    await t5TenantIsolation(pool);
    console.log(
      "\nBackfill §28 (28.1 lote · 28.2 checkpoint+CAS · 28.3 rate-limit · 28.4 idempotência · 28.5 observabilidade): OK",
    );
  } finally {
    await pool.end();
  }
}

async function teardown(): Promise<void> {
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 1 });
  try {
    // O ledger é schema-managed: o teardown remove apenas a fixture local e os
    // tenants de laboratório (o cascade leva as linhas do ledger).
    await pool.query("drop table if exists backfill_demo_rows");
    for (const table of MEMORY_TRAIL_TABLES) {
      // pi-lens-ignore: no-sql-in-code
      await pool.query(`delete from ${table} where tenant_id in ($1, $2)`, [TENANT_A, TENANT_B]);
    }
    await pool.query("delete from tenants where id in ($1, $2)", [TENANT_A, TENANT_B]);
    await pool.query("delete from users where id in ($1, $2)", [USER_A, USER_B]);
    console.log("Fixtures do backfill removidas.");
  } finally {
    await pool.end();
  }
}

const phase =
  process.argv.find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length) ?? "all";
if (phase === "crash") await crashPhase();
else if (phase === "teardown") await teardown();
else if (phase === "all") await fullStory();
else throw new Error(`fase desconhecida: ${phase}`);
