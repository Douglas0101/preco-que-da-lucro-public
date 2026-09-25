import { describe, expect, it } from "vitest";
import {
  BackfillAbortedError,
  createBackfillRunner,
  type BackfillCheckpoint,
  type BackfillCheckpointStore,
  type BackfillProgressEvent,
  type BackfillSink,
  type BackfillSource,
} from "../../scripts/db/backfill-runner";

interface DemoRow {
  id: string;
  value: number;
}

const ROWS: readonly DemoRow[] = Array.from({ length: 10 }, (_, index) => ({
  id: `r${String(index + 1).padStart(2, "0")}`,
  value: index + 1,
}));

/** Relógio virtual: `sleep` move apenas o tempo virtual (nenhum timer real). */
function virtualClock(start = 1_700_000_000_000) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
    elapsedMs: () => current - start,
  };
}

function memoryCheckpointStore() {
  const saved = new Map<string, BackfillCheckpoint>();
  const store: BackfillCheckpointStore = {
    load: async (runKey) => saved.get(runKey) ?? null,
    save: async (runKey, checkpoint) => {
      saved.set(runKey, checkpoint);
    },
  };
  return { store, saved };
}

/** Fonte keyset: devolve as linhas com `id > cursor`, em ordem, até `batchSize`. */
function sourceOf(
  rows: readonly DemoRow[],
  calls: Array<{ cursor: string | null; batchSize: number }> = [],
): BackfillSource<DemoRow> {
  return {
    fetchChunk: async ({ cursor, batchSize }) => {
      calls.push({ cursor, batchSize });
      return rows.filter((row) => cursor === null || row.id > cursor).slice(0, batchSize);
    },
  };
}

/**
 * Efeito idempotente por `workKey` (espelha `ON CONFLICT` do marcador): a
 * primeira aplicação grava, a reaplicação devolve `duplicate` sem gravar.
 */
function effectSink(options: { failOn?: string } = {}) {
  const writes = new Map<string, number>();
  const workKeys = new Set<string>();
  const attempts: string[] = [];
  let failed = false;
  const sink: BackfillSink<DemoRow> = {
    apply: async (row, context) => {
      attempts.push(context.workKey);
      if (options.failOn === row.id && !failed) {
        failed = true;
        throw new Error(`falha simulada em ${row.id}`);
      }
      if (workKeys.has(context.workKey)) return "duplicate";
      workKeys.add(context.workKey);
      writes.set(row.id, (writes.get(row.id) ?? 0) + 1);
      return "applied";
    },
  };
  return { sink, writes, workKeys, attempts };
}

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    workKey: "demo.derived_value:v1",
    runKey: "backfill-demo",
    batchSize: 3,
    keyOf: (row: DemoRow) => row.id,
    ...over,
  } as Parameters<typeof createBackfillRunner<DemoRow>>[0];
}

const writesOf = (writes: Map<string, number>, rows: readonly DemoRow[]) =>
  rows.map((row) => writes.get(row.id) ?? 0);

describe("§28 backfill runner", () => {
  it("T1 — lote + checkpoint: retoma do último lote após falha, sem duplicar efeito", async () => {
    const clock = virtualClock();
    const checkpoints = memoryCheckpointStore();
    const effect = effectSink({ failOn: "r05" });
    const fetches1: Array<{ cursor: string | null; batchSize: number }> = [];
    const fetches2: Array<{ cursor: string | null; batchSize: number }> = [];
    const common = {
      checkpoints: checkpoints.store,
      now: clock.now,
      sleep: clock.sleep,
    };

    const failure = await createBackfillRunner(
      baseOptions({ ...common, source: sourceOf(ROWS, fetches1), sink: effect.sink }),
    )
      .run()
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(BackfillAbortedError);
    const aborted = failure as BackfillAbortedError;
    expect(aborted.summary).toMatchObject({
      resumed: false,
      completed: false,
      batches: 2,
      rowsScanned: 5,
      rowsApplied: 4,
      rowsDuplicate: 0,
      errors: 1,
    });
    // O checkpoint só avança em lote fechado: o lote que falhou (r04..r06) é retomado inteiro.
    expect(aborted.summary.checkpoint.batches).toBe(1);
    expect(aborted.summary.checkpoint.rowsScanned).toBe(3);
    expect(aborted.summary.checkpoint.cursor).toBe("r03");
    expect(checkpoints.saved.get("backfill-demo")?.cursor).toBe("r03");
    expect(fetches1.map((call) => call.cursor)).toEqual([null, "r03"]);
    expect(writesOf(effect.writes, ROWS).slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(writesOf(effect.writes, ROWS).slice(4)).toEqual([0, 0, 0, 0, 0, 0]);

    const resumed = await createBackfillRunner(
      baseOptions({ ...common, source: sourceOf(ROWS, fetches2), sink: effect.sink }),
    ).run();

    expect(resumed.resumed).toBe(true);
    expect(resumed.completed).toBe(true);
    expect(fetches2[0].cursor).toBe("r03");
    expect(resumed.rowsDuplicate).toBe(1);
    expect(resumed.rowsScanned).toBe(7);
    expect(resumed.rowsApplied).toBe(6);
    expect(resumed.checkpoint.cursor).toBe("r10");
    expect(resumed.rowsPerSecond).toBeGreaterThan(0);
    // Efeito final correto e sem duplicação em nenhuma linha.
    expect(writesOf(effect.writes, ROWS)).toEqual(ROWS.map(() => 1));
    expect(checkpoints.saved.get("backfill-demo")?.completed).toBe(true);
  });

  it("T2 — rate-limit por janela respeitado com tempo injetado (sem espera real)", async () => {
    const rows = ROWS.slice(0, 9);
    const clock = virtualClock();
    const checkpoints = memoryCheckpointStore();
    const effect = effectSink();
    const realStart = performance.now();

    const summary = await createBackfillRunner(
      baseOptions({
        source: sourceOf(rows),
        sink: effect.sink,
        checkpoints: checkpoints.store,
        now: clock.now,
        sleep: clock.sleep,
        batchSize: 2,
        rateLimit: { maxRows: 4, windowMs: 1000 },
      }),
    ).run();
    const realMs = performance.now() - realStart;

    // 9 linhas, no máximo 4 por janela de 1 s ⇒ duas janelas cheias.
    expect(clock.sleeps).toEqual([1000, 1000]);
    expect(summary.rateLimitWaits).toBe(2);
    expect(summary.rateLimitWaitMs).toBe(2000);
    expect(summary.durationMs).toBe(2000);
    expect(summary.rowsScanned).toBe(9);
    expect(summary.rowsApplied).toBe(9);
    expect(summary.rowsPerSecond).toBeCloseTo(4.5, 5);
    expect(realMs).toBeLessThan(250);
  });

  it("T3 — idempotência: rodar 2× ⇒ mesmo estado (2ª passada só duplicata)", async () => {
    const clock = virtualClock();
    const checkpoints = memoryCheckpointStore();
    const effect = effectSink();

    const first = await createBackfillRunner(
      baseOptions({
        runKey: "backfill-demo:p1",
        source: sourceOf(ROWS),
        sink: effect.sink,
        checkpoints: checkpoints.store,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).run();
    const stateAfterFirst = writesOf(effect.writes, ROWS);
    expect(first.rowsApplied).toBe(10);
    expect(first.rowsDuplicate).toBe(0);
    expect(stateAfterFirst).toEqual(ROWS.map(() => 1));

    const second = await createBackfillRunner(
      baseOptions({
        runKey: "backfill-demo:p2",
        source: sourceOf(ROWS),
        sink: effect.sink,
        checkpoints: checkpoints.store,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).run();

    expect(second.rowsScanned).toBe(10);
    expect(second.rowsApplied).toBe(0);
    expect(second.rowsDuplicate).toBe(10);
    expect(second.completed).toBe(true);
    expect(writesOf(effect.writes, ROWS)).toEqual(stateAfterFirst);
    // A chave de trabalho é derivada da linha (e não da tentativa): o efeito é globalmente idempotente.
    expect(effect.workKeys).toEqual(new Set(ROWS.map((row) => `demo.derived_value:v1#${row.id}`)));

    // Mesma tentativa já concluída ⇒ no-op: nenhuma linha relida, mesmo estado.
    const fetchesAfter: Array<{ cursor: string | null; batchSize: number }> = [];
    const repeat = await createBackfillRunner(
      baseOptions({
        runKey: "backfill-demo:p2",
        source: sourceOf(ROWS, fetchesAfter),
        sink: effect.sink,
        checkpoints: checkpoints.store,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).run();
    expect(fetchesAfter).toEqual([]);
    // Tentativa já concluída: 0 linhas nesta execução; o acumulado vive no checkpoint.
    expect(repeat).toMatchObject({ resumed: true, completed: true, rowsScanned: 0, errors: 0 });
    expect(repeat.checkpoint.rowsScanned).toBe(10);
    expect(repeat.checkpoint.rowsApplied).toBe(0);
    expect(repeat.checkpoint.rowsDuplicate).toBe(10);
    expect(writesOf(effect.writes, ROWS)).toEqual(stateAfterFirst);
  });

  it("T4 — observabilidade: evento por lote com contadores, taxa e checkpoint atual", async () => {
    const rows = ROWS.slice(0, 6);
    const clock = virtualClock();
    const checkpoints = memoryCheckpointStore();
    const effect = effectSink();
    const events: BackfillProgressEvent[] = [];

    const summary = await createBackfillRunner(
      baseOptions({
        source: sourceOf(rows),
        sink: effect.sink,
        checkpoints: checkpoints.store,
        batchSize: 2,
        now: clock.now,
        sleep: clock.sleep,
        onProgress: (event: BackfillProgressEvent) => events.push(event),
      }),
    ).run();

    expect(events.map((event) => event.type)).toEqual(["batch", "batch", "batch", "completed"]);
    expect(events.map((event) => event.batch)).toEqual([1, 2, 3, 3]);
    expect(events.map((event) => event.rows)).toEqual([2, 2, 2, 0]);
    expect(events.map((event) => event.rowsScanned)).toEqual([2, 4, 6, 6]);
    expect(events.map((event) => event.cursor)).toEqual(["r02", "r04", "r06", "r06"]);
    expect(events.map((event) => event.checkpoint.completed)).toEqual([false, false, false, true]);
    for (const event of events) {
      expect(event.runKey).toBe("backfill-demo");
      expect(event.rowsPerSecond).toBeGreaterThan(0);
      expect(event.errors).toBe(0);
    }
    expect(events.at(-1)?.checkpoint).toEqual(summary.checkpoint);
    expect(summary).toMatchObject({
      batches: 3,
      rowsScanned: 6,
      rowsApplied: 6,
      rowsDuplicate: 0,
      errors: 0,
      completed: true,
      resumed: false,
    });
    expect(summary.checkpoint.cursor).toBe("r06");
    expect(summary.checkpoint.updatedAt).toBe(new Date(clock.now()).toISOString());
  });

  it("validação — batchSize/rateLimit inválidos falham alto (não silenciam o backfill)", async () => {
    const clock = virtualClock();
    const checkpoints = memoryCheckpointStore();
    const effect = effectSink();
    const build = (over: Record<string, unknown>) =>
      createBackfillRunner(
        baseOptions({
          source: sourceOf(ROWS),
          sink: effect.sink,
          checkpoints: checkpoints.store,
          now: clock.now,
          sleep: clock.sleep,
          ...over,
        }),
      );

    expect(() => build({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => build({ batchSize: 2.5 })).toThrow(/batchSize/);
    expect(() => build({ workKey: "  " })).toThrow(/workKey/);
    expect(() => build({ rateLimit: { maxRows: 10, windowMs: 0 } })).toThrow(/rateLimit/);
    expect(() => build({})).not.toThrow();
  });
});
