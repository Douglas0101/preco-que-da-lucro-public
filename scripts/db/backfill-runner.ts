/**
 * §28 — runner de backfill (batch · checkpoint · rate-limit · idempotência ·
 * observabilidade).
 *
 * Runner genérico e reutilizável para qualquer backfill de volume futuro: nada
 * aqui conhece tabela, coluna ou domínio. O chamador injeta as três peças
 * (§28 exige que o contrato seja testável sem banco):
 *
 * - `source.fetchChunk`  — lote de linhas a partir de um cursor opaco, keyset,
 *   em ordem ascendente pelo mesmo campo que `keyOf` devolve. O runner nunca
 *   compara cursores: quem define a ordenação/comparação é a fonte (SQL).
 * - `sink.apply`         — efeito de UMA linha, **idempotente** para a
 *   `workKey` recebida (na prática: marcador `INSERT … ON CONFLICT DO NOTHING`
 *   gravado na MESMA transação do efeito, como §23 faz no consumidor de
 *   outbox). Devolve `applied` (efeito novo) ou `duplicate` (já estava feito).
 * - `checkpoints`        — persistência do progresso (`cursor` + contadores).
 *   O avanço é **CAS por versão**: dois runners no mesmo `runKey` nunca se
 *   sobrescrevem em silêncio — quem perde recebe `BackfillCheckpointConflictError`.
 *
 * Garantias (ver `src/test/backfill-runner.test.ts` T1–T4):
 * - O checkpoint só avança em **lote fechado**: uma interrupção no meio de um
 *   lote (falha de linha, crash, SIGKILL) deixa o cursor no último lote
 *   completo, e a retomada reprocessa o lote inteiro. Efeitos já aplicados
 *   voltam como `duplicate` — at-least-once + efeito idempotente, nunca duplica.
 * - `rateLimit` limita linhas por janela; o tempo é injetável (`now`/`sleep`),
 *   então o teste prova a janela sem espera real.
 * - `onProgress` recebe um evento por lote (e um evento final) com linhas do
 *   lote, contadores acumulados, taxa, erro e checkpoint corrente.
 *
 * Uso: `npx tsx scripts/db/test-backfill.ts` para o caso de integração real
 * (container efêmero PG17) e `src/test/backfill-runner.test.ts` para o
 * contrato puro.
 */

export interface BackfillChunkRequest {
  /** Cursor da última linha de um lote fechado; `null` = início do trabalho. */
  readonly cursor: string | null;
  readonly batchSize: number;
}

export interface BackfillSource<T> {
  /** Até `batchSize` linhas com chave **estritamente maior** que `cursor`. */
  fetchChunk(request: BackfillChunkRequest): Promise<readonly T[]>;
}

export interface BackfillApplyContext {
  /** Identidade estável do efeito: `<workKey>#<rowKey>`. Sobrevive a retomadas. */
  readonly workKey: string;
  readonly rowKey: string;
  readonly runKey: string;
  /** Número 1-based do lote em execução. */
  readonly batch: number;
}

export type BackfillApplyOutcome = "applied" | "duplicate";

export interface BackfillSink<T> {
  apply(row: T, context: BackfillApplyContext): Promise<BackfillApplyOutcome>;
}

export interface BackfillCheckpoint {
  readonly cursor: string | null;
  readonly completed: boolean;
  readonly batches: number;
  readonly rowsScanned: number;
  readonly rowsApplied: number;
  readonly rowsDuplicate: number;
  readonly errors: number;
  /**
   * Token do CAS. `load` devolve a versão persistida; `save` recebe a versão
   * NOVA (a anterior + 1) e só grava se a persistida ainda for a anterior.
   * `0` significa "nada persistido ainda".
   */
  readonly version: number;
  readonly updatedAt: string;
}

export interface BackfillCheckpointStore {
  /**
   * `runKey` identifica a TENTATIVA (checkpoint). A identidade do EFEITO é a
   * `workKey`, compartilhada entre tentativas — por isso reexecutar o mesmo
   * trabalho com outra tentativa não reaplica nada.
   */
  load(runKey: string): Promise<BackfillCheckpoint | null>;
  /**
   * Gravação condicional por versão (CAS): persiste `checkpoint` apenas se a
   * versão em disco ainda for `checkpoint.version - 1`; a linha passa a valer
   * `checkpoint.version`. Perdeu a corrida ⇒ `BackfillCheckpointConflictError`
   * (explícito) — nunca sobrescreve em silêncio o avanço de outro runner.
   */
  save(runKey: string, checkpoint: BackfillCheckpoint): Promise<void>;
}

/** `save` perdeu a corrida do CAS: outro runner avançou o checkpoint primeiro. */
export class BackfillCheckpointConflictError extends Error {
  readonly runKey: string;
  /** Versão que este runner acreditava estar persistida. */
  readonly expectedVersion: number;

  constructor(runKey: string, expectedVersion: number) {
    super(
      `backfill-runner: checkpoint de "${runKey}" está em outra versão (CAS esperava a versão ${expectedVersion}); ` +
        "outro runner avançou primeiro — este run foi descartado sem sobrescrever nada",
    );
    this.name = "BackfillCheckpointConflictError";
    this.runKey = runKey;
    this.expectedVersion = expectedVersion;
  }
}

export interface BackfillRateLimit {
  /** Máximo de linhas aplicadas por janela de `windowMs`. */
  readonly maxRows: number;
  readonly windowMs: number;
}

/**
 * Contadores da tentativa em curso — incluem o lote ainda **não fechado**
 * (por isso `batches`/`rowsScanned` podem passar de `checkpoint.*` numa
 * interrupção). `checkpoint` é sempre o último estado persistido.
 */
export interface BackfillCounters {
  /** Lotes iniciados. */
  readonly batches: number;
  readonly rowsScanned: number;
  readonly rowsApplied: number;
  readonly rowsDuplicate: number;
  readonly errors: number;
  readonly cursor: string | null;
  readonly completed: boolean;
  readonly checkpoint: BackfillCheckpoint;
}

export interface BackfillProgressEvent extends BackfillCounters {
  readonly type: "batch" | "completed";
  readonly runKey: string;
  readonly batch: number;
  /** Linhas lidas NESTE lote (0 no evento final de fila esgotada). */
  readonly rows: number;
  readonly elapsedMs: number;
  readonly rowsPerSecond: number;
}

export interface BackfillRunSummary extends BackfillCounters {
  readonly runKey: string;
  readonly workKey: string;
  readonly batchSize: number;
  /** `true` quando o checkpoint encontrado foi reaproveitado (retomada). */
  readonly resumed: boolean;
  readonly rateLimitWaits: number;
  readonly rateLimitWaitMs: number;
  readonly durationMs: number;
  readonly rowsPerSecond: number;
}

export interface BackfillRunnerOptions<T> {
  /** Identidade estável do trabalho lógico (ex.: `expenses.derived:v1`). */
  readonly workKey: string;
  /** Tentativa (checkpoint). Default: a própria `workKey`. */
  readonly runKey?: string;
  readonly batchSize: number;
  readonly keyOf: (row: T) => string;
  readonly source: BackfillSource<T>;
  readonly sink: BackfillSink<T>;
  readonly checkpoints: BackfillCheckpointStore;
  readonly rateLimit?: BackfillRateLimit;
  /**
   * `abort` (default) interrompe o run na primeira falha de linha preservando o
   * checkpoint — o lote inteiro é reintentado na retomada (erro de linha
   * costuma ser sistemático). `skip` segue adiante e conta o erro: a linha
   * fica atrás do cursor e NÃO é reintentada (exige reconciliação à parte).
   */
  readonly onRowError?: "abort" | "skip";
  readonly onProgress?: (event: BackfillProgressEvent) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BackfillRunner<T> {
  run(): Promise<BackfillRunSummary>;
}

/** Falha de linha com `onRowError: "abort"`: carrega o resumo do que ficou feito. */
export class BackfillAbortedError extends Error {
  readonly summary: BackfillRunSummary;

  constructor(rowKey: string, batch: number, summary: BackfillRunSummary, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Backfill abortado no lote ${batch} (linha ${rowKey}): ${reason}`, { cause });
    this.name = "BackfillAbortedError";
    this.summary = summary;
  }
}

export function createBackfillRunner<T>(options: BackfillRunnerOptions<T>): BackfillRunner<T> {
  const { workKey, source, sink, checkpoints, keyOf } = options;
  if (typeof workKey !== "string" || workKey.trim() === "") {
    throw new Error("backfill-runner: workKey é obrigatória (identidade do trabalho lógico)");
  }
  const runKey = options.runKey ?? workKey;
  if (typeof runKey !== "string" || runKey.trim() === "") {
    throw new Error("backfill-runner: runKey não pode ser vazia");
  }
  const { batchSize } = options;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`backfill-runner: batchSize deve ser inteiro > 0 (recebido ${batchSize})`);
  }
  const rateLimit = options.rateLimit;
  if (
    rateLimit &&
    (!Number.isInteger(rateLimit.maxRows) || rateLimit.maxRows <= 0 || !(rateLimit.windowMs > 0))
  ) {
    throw new Error(
      `backfill-runner: rateLimit exige maxRows inteiro > 0 e windowMs > 0 (recebido ${rateLimit.maxRows}/${rateLimit.windowMs})`,
    );
  }
  const abortOnRowError = (options.onRowError ?? "abort") === "abort";
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  // Taxa com piso de 1 ms: um run instantâneo não deve reportar `Infinity`.
  const ratePerSecond = (rows: number, elapsedMs: number) =>
    rows === 0 ? 0 : (rows * 1000) / Math.max(elapsedMs, 1);

  let windowStart: number | null = null;
  let windowUsed = 0;
  let rateLimitWaits = 0;
  let rateLimitWaitMs = 0;

  /** Consome 1 linha da janela, dormindo (tempo injetado) quando ela enche. */
  async function acquireRateLimitSlot(): Promise<void> {
    if (!rateLimit) return;
    const current = now();
    if (windowStart === null) windowStart = current;
    if (windowUsed + 1 > rateLimit.maxRows) {
      const waitMs = windowStart + rateLimit.windowMs - current;
      if (waitMs > 0) {
        rateLimitWaits += 1;
        rateLimitWaitMs += waitMs;
        await sleep(waitMs);
      }
      windowStart = now();
      windowUsed = 0;
    }
    windowUsed += 1;
  }

  async function run(): Promise<BackfillRunSummary> {
    const startedAt = now();
    const existing = await checkpoints.load(runKey);
    const resumed = existing !== null;
    let cursor = existing?.cursor ?? null;
    // Acumulado do runKey, persistido em lote fechado (só avança com o lote inteiro).
    let committedBatches = existing?.batches ?? 0;
    let committedScanned = existing?.rowsScanned ?? 0;
    let committedApplied = existing?.rowsApplied ?? 0;
    let committedDuplicate = existing?.rowsDuplicate ?? 0;
    let committedErrors = existing?.errors ?? 0;
    // Tentativa corrente: zerada a cada `run()` — a taxa por segundo é do trabalho
    // desta execução, não do acumulado do runKey.
    let batches = 0;
    let rowsScanned = 0;
    let rowsApplied = 0;
    let rowsDuplicate = 0;
    let errors = 0;
    let batchApplied = 0;
    let batchDuplicate = 0;
    let batchErrors = 0;
    let checkpoint: BackfillCheckpoint = existing ?? {
      cursor,
      completed: false,
      batches: 0,
      rowsScanned: 0,
      rowsApplied: 0,
      rowsDuplicate: 0,
      errors: 0,
      version: 0,
      updatedAt: new Date(startedAt).toISOString(),
    };

    const summary = (completed: boolean): BackfillRunSummary => {
      const durationMs = now() - startedAt;
      return {
        runKey,
        workKey,
        batchSize,
        resumed,
        batches,
        rowsScanned,
        rowsApplied,
        rowsDuplicate,
        errors,
        cursor,
        completed,
        checkpoint,
        rateLimitWaits,
        rateLimitWaitMs,
        durationMs,
        rowsPerSecond: ratePerSecond(rowsScanned, durationMs),
      };
    };

    /** Fecha o lote: dobra o lote corrente no acumulado e persiste o checkpoint. */
    const commitBatch = async (committedRows: number, completed: boolean) => {
      committedBatches += 1;
      committedScanned += committedRows;
      committedApplied += batchApplied;
      committedDuplicate += batchDuplicate;
      committedErrors += batchErrors;
      batchApplied = 0;
      batchDuplicate = 0;
      batchErrors = 0;
      const next: BackfillCheckpoint = {
        cursor,
        completed,
        batches: committedBatches,
        rowsScanned: committedScanned,
        rowsApplied: committedApplied,
        rowsDuplicate: committedDuplicate,
        errors: committedErrors,
        version: checkpoint.version + 1,
        updatedAt: new Date(now()).toISOString(),
      };
      // Avanço condicional: o store só grava se a versão em disco ainda for a
      // anterior (`next.version - 1`). Conflito ⇒ aborta o run inteiro sem
      // adotar a versão que este runner não conseguiu persistir.
      await checkpoints.save(runKey, next);
      checkpoint = next;
    };

    const emit = (type: BackfillProgressEvent["type"], rows: number, completed: boolean) => {
      if (!options.onProgress) return;
      const elapsedMs = now() - startedAt;
      options.onProgress({
        type,
        runKey,
        batch: batches,
        rows,
        batches,
        rowsScanned,
        rowsApplied,
        rowsDuplicate,
        errors,
        cursor,
        completed,
        checkpoint,
        elapsedMs,
        rowsPerSecond: ratePerSecond(rowsScanned, elapsedMs),
      });
    };

    // Trabalho já concluído nessa tentativa: nada a fazer (2ª execução = no-op).
    if (existing?.completed) {
      emit("completed", 0, true);
      return summary(true);
    }

    for (;;) {
      const rows = await source.fetchChunk({ cursor, batchSize });
      if (rows.length === 0) {
        await commitBatch(0, true);
        emit("completed", 0, true);
        return summary(true);
      }

      batches += 1;
      for (const row of rows) {
        await acquireRateLimitSlot();
        rowsScanned += 1;
        const rowKey = keyOf(row);
        try {
          const outcome = await sink.apply(row, {
            workKey: `${workKey}#${rowKey}`,
            rowKey,
            runKey,
            batch: batches,
          });
          if (outcome === "duplicate") {
            rowsDuplicate += 1;
            batchDuplicate += 1;
          } else {
            rowsApplied += 1;
            batchApplied += 1;
          }
        } catch (error) {
          errors += 1;
          batchErrors += 1;
          if (abortOnRowError) {
            // Lote NÃO fechado: o checkpoint fica no lote anterior e a retomada
            // relê este lote inteiro (o efeito já aplicado volta como duplicata).
            throw new BackfillAbortedError(rowKey, batches, summary(false), error);
          }
        }
      }

      cursor = keyOf(rows[rows.length - 1]);
      // Último lote da fila: `fetchChunk` devolveu menos que o lote pedido.
      const exhausted = rows.length < batchSize;
      await commitBatch(rows.length, exhausted);
      emit(exhausted ? "completed" : "batch", rows.length, exhausted);
      if (exhausted) return summary(true);
    }
  }

  return { run };
}
