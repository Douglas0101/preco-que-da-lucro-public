/**
 * §23 (23.2) — worker do outbox: drena o lote pendente do tenant e entrega cada
 * evento a um handler injetável, com idempotência do consumidor.
 *
 * Garantias:
 *   - `FOR UPDATE SKIP LOCKED` (no claim do repositório) particiona a fila entre
 *     workers concorrentes sem bloquear nem repetir evento;
 *   - claim, efeito do handler e marcação final ficam na MESMA transação, então
 *     um crash/abort devolve o evento à fila sem estado intermediário;
 *   - a entrega é at-least-once: a inbox (consumer_name, event_id) é gravada no
 *     savepoint do handler e reverte junto com ele, de modo que a reentrega
 *     reexecuta o handler só quando o efeito anterior não commitou;
 *   - falha consome uma tentativa, agenda `available_at` no futuro (backoff) e
 *     para de ser reclamada ao atingir `maxAttempts` — sem retry infinito.
 */
import type { OutboxEvent } from "@/db/schema";
import {
  bindTransactionContext,
  type RequestContext,
  type RequestIdentity,
} from "@/lib/request-context";
import {
  transactionManager as defaultTransactionManager,
  type DatabaseIdentity,
  type DatabaseTransaction,
  type TransactionManager,
} from "@/db/client.server";
import { outboxRepository, type OutboxStore } from "@/server/repositories/outbox.repository";
import type { Executor } from "@/server/contracts/event.contracts";

/** Efeito do consumidor para um evento; roda na transação/savepoint do lote. */
export type OutboxEventHandler = (
  event: OutboxEvent,
  executor: DatabaseTransaction,
) => Promise<void>;

export interface OutboxWorkerOptions {
  /** Limite do lote por claim; precisa ser > 0 (§23). */
  batchSize?: number;
  /** Tentativas máximas antes de parar de reclamar o evento. */
  maxAttempts?: number;
  /** Backoff em ms a partir das tentativas já consumidas pelo claim. */
  backoffMs?: (attempts: number) => number;
  /** Identidade do consumidor: a chave da inbox é (consumerName, eventId). */
  consumerName?: string;
}

export interface OutboxWorkerDependencies {
  store?: OutboxStore;
  transactionManager?: TransactionManager;
}

export interface OutboxBatchResult {
  claimed: number;
  processed: number;
  /** Reentregas de evento já consumido por este consumidor: 0 efeito novo. */
  duplicates: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CONSUMER_NAME = "outbox-worker";
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const LAST_ERROR_MAX_LENGTH = 1_000;

/** `last_error` é diagnóstico: normaliza o erro e limita o tamanho da coluna. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > LAST_ERROR_MAX_LENGTH
    ? `${message.slice(0, LAST_ERROR_MAX_LENGTH)}…`
    : message;
}

export class OutboxWorker {
  private readonly store: OutboxStore;
  private readonly transactions: TransactionManager;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly consumerName: string;
  private readonly customBackoff: ((attempts: number) => number) | undefined;

  constructor(
    private readonly handler: OutboxEventHandler,
    options: OutboxWorkerOptions = {},
    dependencies: OutboxWorkerDependencies = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.consumerName = options.consumerName ?? DEFAULT_CONSUMER_NAME;
    this.customBackoff = options.backoffMs;
    this.store = dependencies.store ?? outboxRepository;
    this.transactions = dependencies.transactionManager ?? defaultTransactionManager;

    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error("OUTBOX_BATCH_SIZE_INVALID");
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts <= 0) {
      throw new Error("OUTBOX_MAX_ATTEMPTS_INVALID");
    }
    if (!this.consumerName.trim()) throw new Error("OUTBOX_CONSUMER_NAME_INVALID");
  }

  /** Backoff exponencial com teto (1s, 2s, 4s…), substituível nos testes. */
  backoffMs(attempts: number): number {
    if (this.customBackoff) return this.customBackoff(attempts);
    return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  }

  /**
   * Drena um lote do tenant corrente dentro do executor recebido. Cada evento
   * roda no seu savepoint: a falha de um não aborta o lote nem o efeito dos
   * anteriores, e o `markFailed` roda na transação externa ainda saudável.
   */
  async processBatch(
    context: RequestContext,
    executor: Executor = context.transaction,
  ): Promise<OutboxBatchResult> {
    // §9.2 — o worker é adapter: estreita o handle neutro para a transação do
    // driver (o savepoint de cada evento é API do driver).
    const tx = executor as DatabaseTransaction;
    const claimed = await this.store.claimPending(
      context,
      { batchSize: this.batchSize, maxAttempts: this.maxAttempts },
      tx,
    );
    const result: OutboxBatchResult = {
      claimed: claimed.length,
      processed: 0,
      duplicates: 0,
      failed: 0,
    };

    for (const event of claimed) {
      try {
        const firstDelivery = await tx.transaction(async (savepoint) => {
          const consumed = await this.store.markConsumed(
            context,
            this.consumerName,
            event.id,
            savepoint,
          );
          if (consumed) await this.handler(event, savepoint);
          await this.store.markProcessed(context, event.id, savepoint);
          return consumed;
        });
        if (firstDelivery) result.processed += 1;
        else result.duplicates += 1;
      } catch (error) {
        result.failed += 1;
        await this.store.markFailed(
          context,
          event.id,
          { error: errorText(error), backoffMs: this.backoffMs(event.attempts) },
          tx,
        );
      }
    }

    return result;
  }

  /** Superfície do contrato M-04: devolve quantos eventos foram publicados. */
  async publishPending(context: RequestContext, executor?: Executor): Promise<number> {
    const result = await this.processBatch(context, executor);
    return result.processed;
  }

  /** Entrada do runner de background: abre a transação do tenant e drena um lote. */
  async runOnce(identity: DatabaseIdentity): Promise<OutboxBatchResult> {
    const requestIdentity: RequestIdentity = {
      ...identity,
      correlationId: `outbox-worker:${this.consumerName}`,
      // Sem request: não há cancelamento a propagar para o consumidor.
      signal: new AbortController().signal,
    };
    return this.transactions.run(identity, (transaction) =>
      this.processBatch(bindTransactionContext(requestIdentity, transaction), transaction),
    );
  }
}
