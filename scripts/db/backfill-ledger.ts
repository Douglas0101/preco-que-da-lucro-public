/**
 * §28 — persistência do backfill em Postgres: checkpoint retomável + marcador de
 * idempotência (`work key`).
 *
 * O runner (`backfill-runner.ts`) é puro e recebe essas duas peças por injeção;
 * este módulo é a implementação sobre `pg`, usada pelo caso de integração
 * (`test-backfill.ts`) e reutilizável por qualquer backfill futuro.
 *
 * As tabelas são **schema-managed** (`src/db/schema.ts` + migration gerada),
 * tenant-scoped e sob RLS: `(tenant_id, run_key)` é a PK do checkpoint e
 * `(tenant_id, work_key)` a do marcador. Este módulo nunca cria DDL.
 *
 * Invariantes:
 * - O checkpoint avança por **CAS de versão** (`save` grava só se a versão em
 *   disco ainda for `checkpoint.version - 1`); dois runners no mesmo `runKey`
 *   ⇒ exatamente um avança, o outro recebe `BackfillCheckpointConflictError`.
 * - `backfill_work_items.work_key` é derivada da LINHA (não da tentativa):
 *   reexecutar o mesmo trabalho em outra tentativa não reaplica o efeito — o
 *   `INSERT … ON CONFLICT DO NOTHING` é a arbitragem.
 * - O marcador e o efeito rodam na MESMA transação (`applyWorkItemOnce`): se o
 *   efeito falha, o marcador desaparece com ele; se o processo morre depois do
 *   commit, o marcador sobrevive e a retomada vê `duplicate`.
 */

import type { Pool, PoolClient } from "pg";
import {
  BackfillCheckpointConflictError,
  type BackfillApplyOutcome,
  type BackfillCheckpoint,
  type BackfillCheckpointStore,
} from "./backfill-runner";

export interface BackfillLedgerOptions {
  /** Tenant dono do trabalho — é a chave da RLS do ledger. */
  readonly tenantId: string;
}

interface CheckpointRow {
  cursor: string | null;
  completed: boolean;
  batches: number;
  rows_scanned: number;
  rows_applied: number;
  rows_duplicate: number;
  errors: number;
  version: number;
  updated_at: Date;
}

export function createPostgresCheckpointStore(
  pool: Pool,
  options: BackfillLedgerOptions,
): BackfillCheckpointStore {
  const { tenantId } = options;
  return {
    load: async (runKey) => {
      const result = await pool.query<CheckpointRow>(
        `select cursor, completed, batches, rows_scanned, rows_applied, rows_duplicate, errors, version, updated_at
         from backfill_checkpoints where tenant_id = $1 and run_key = $2`,
        [tenantId, runKey],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        cursor: row.cursor,
        completed: row.completed,
        batches: row.batches,
        rowsScanned: row.rows_scanned,
        rowsApplied: row.rows_applied,
        rowsDuplicate: row.rows_duplicate,
        errors: row.errors,
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      } satisfies BackfillCheckpoint;
    },
    save: async (runKey, checkpoint) => {
      // CAS numa única instrução: sem linha ⇒ INSERT na versão pedida; com linha
      // ⇒ UPDATE somente se a versão gravada for exatamente a anterior
      // (`excluded.version - 1`). Corrida perdida devolve rowCount 0.
      const result = await pool.query(
        `insert into backfill_checkpoints
           (tenant_id, run_key, cursor, completed, batches, rows_scanned, rows_applied, rows_duplicate, errors, version, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         on conflict (tenant_id, run_key) do update set
           cursor = excluded.cursor,
           completed = excluded.completed,
           batches = excluded.batches,
           rows_scanned = excluded.rows_scanned,
           rows_applied = excluded.rows_applied,
           rows_duplicate = excluded.rows_duplicate,
           errors = excluded.errors,
           version = excluded.version,
           updated_at = excluded.updated_at
         where backfill_checkpoints.version = excluded.version - 1`,
        [
          tenantId,
          runKey,
          checkpoint.cursor,
          checkpoint.completed,
          checkpoint.batches,
          checkpoint.rowsScanned,
          checkpoint.rowsApplied,
          checkpoint.rowsDuplicate,
          checkpoint.errors,
          checkpoint.version,
          checkpoint.updatedAt,
        ],
      );
      if (result.rowCount === 0) {
        throw new BackfillCheckpointConflictError(runKey, checkpoint.version - 1);
      }
    },
  };
}

export interface WorkItemApply extends BackfillLedgerOptions {
  /** `<workKey>#<rowKey>` — identidade global do efeito. */
  readonly workKey: string;
  /** Tentativa que está aplicando (rastreabilidade). */
  readonly runKey: string;
  readonly rowKey: string;
  /** Efeito da linha, executado na MESMA transação do marcador. */
  readonly effect: (client: PoolClient) => Promise<void>;
}

/**
 * Aplica o efeito de uma linha exatamente uma vez: marca a `workKey`
 * (`ON CONFLICT DO NOTHING`) e só então executa o efeito, tudo numa transação.
 * Já marcado ⇒ devolve `duplicate` sem tocar no efeito.
 */
export async function applyWorkItemOnce(
  pool: Pool,
  input: WorkItemApply,
): Promise<BackfillApplyOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ work_key: string }>(
      `insert into backfill_work_items (tenant_id, work_key, run_key, row_key)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, work_key) do nothing
       returning work_key`,
      [input.tenantId, input.workKey, input.runKey, input.rowKey],
    );
    if (inserted.rowCount === 0) {
      await client.query("rollback");
      return "duplicate";
    }
    await input.effect(client);
    await client.query("commit");
    return "applied";
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
