/**
 * §23 — outbox transacional (23.1) e base de persistência do worker (23.2).
 *
 * O `append` é sempre executado no executor recebido (`context.transaction` por
 * padrão): a mutação de domínio e o evento commitam juntos ou não commitam.
 * `idempotency_key` é única por tenant — repetir o append devolve o evento
 * existente com `duplicate: true` (M-04/F-16) em vez de criar uma segunda linha.
 *
 * O claim usa `FOR UPDATE SKIP LOCKED` limitado por `batchSize`: dois workers
 * concorrentes particionam a fila sem bloquear e sem processar o mesmo evento
 * duas vezes. `processing` é um estado intra-transação do worker — se a
 * transação abortar (crash/JOB morto), o claim volta a `pending` junto com o
 * resto, então não existe linha presa em `processing`.
 */
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { OutboxEvent } from "@/db/schema";
import { outboxConsumptions, outboxEvents } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/client.server";
import { ApplicationError } from "@/lib/api-error";
import type { RequestContext } from "@/lib/request-context";
import type {
  AppendEventResult,
  DomainEventInput,
  EventRepositoryPort,
  Executor,
} from "@/server/contracts/event.contracts";

/** Estados de fila do §23, espelhados no CHECK `outbox_events_status_check`.
 * Só `pending` e `failed` são reclamáveis: `failed` com `attempts` esgotado (ou
 * `available_at` no futuro) fica fora do predicado e não gera retry infinito. */
const CLAIMABLE_STATUSES = ["pending", "failed"] as const;

export interface OutboxClaimOptions {
  /** Limite do lote; precisa ser > 0 (§23). */
  batchSize: number;
  /** Tentativas máximas por evento; precisa ser > 0. */
  maxAttempts: number;
}

/**
 * Porta do dispatcher de pendentes: a implementação viva é `OutboxWorker`
 * (23.2), que reivindica o lote e entrega cada evento ao handler registrado.
 * Mantida aqui (camada de baixo) para o repositório não importar serviços.
 */
export interface OutboxDispatcher {
  publishPending(context: RequestContext, executor?: Executor): Promise<number>;
}

/** Persistência mínima consumida pelo worker (23.2). */
export interface OutboxStore {
  claimPending(
    context: RequestContext,
    options: OutboxClaimOptions,
    executor?: Executor,
  ): Promise<readonly OutboxEvent[]>;
  markConsumed(
    context: RequestContext,
    consumerName: string,
    eventId: string,
    executor?: Executor,
  ): Promise<boolean>;
  markProcessed(context: RequestContext, eventId: string, executor?: Executor): Promise<boolean>;
  markFailed(
    context: RequestContext,
    eventId: string,
    failure: { error: string; backoffMs: number },
    executor?: Executor,
  ): Promise<boolean>;
}

export class DrizzleOutboxRepository implements EventRepositoryPort, OutboxStore {
  constructor(private readonly dispatcher?: OutboxDispatcher) {}

  async append(
    context: RequestContext,
    input: DomainEventInput,
    executor: Executor = context.transaction,
  ): Promise<AppendEventResult> {
    // §9.2 — o adapter estreita o handle neutro do executor para a transação do
    // driver; o contrato (`EventRepositoryPort`) segue driver-agnostic.
    const tx = executor as DatabaseTransaction;
    const inserted = await tx
      .insert(outboxEvents)
      .values({
        tenantId: context.tenantId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({ target: [outboxEvents.tenantId, outboxEvents.idempotencyKey] })
      .returning({ id: outboxEvents.id });
    const created = inserted[0];
    if (created) return { eventId: created.id, duplicate: false };

    const existing = await tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, context.tenantId),
          eq(outboxEvents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error("DATABASE_ERROR");
    return { eventId: row.id, duplicate: true };
  }

  /**
   * Reclama até `batchSize` eventos vencidos do tenant corrente e os marca
   * `processing` com `attempts + 1`, tudo dentro do executor recebido. A linha
   * do claim é a mesma transação do efeito do consumidor (23.2).
   */
  async claimPending(
    context: RequestContext,
    options: OutboxClaimOptions,
    executor: Executor = context.transaction,
  ): Promise<readonly OutboxEvent[]> {
    const tx = executor as DatabaseTransaction;
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new Error("OUTBOX_BATCH_SIZE_INVALID");
    }
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      throw new Error("OUTBOX_MAX_ATTEMPTS_INVALID");
    }

    const candidates = await tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, context.tenantId),
          inArray(outboxEvents.status, [...CLAIMABLE_STATUSES]),
          lte(outboxEvents.availableAt, sql`now()`),
          lt(outboxEvents.attempts, options.maxAttempts),
        ),
      )
      .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(options.batchSize)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];

    return tx
      .update(outboxEvents)
      .set({ status: "processing", attempts: sql`${outboxEvents.attempts} + 1` })
      .where(
        inArray(
          outboxEvents.id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .returning();
  }

  /**
   * Inbox do consumidor: registra (consumer, event) na transação corrente e
   * devolve `true` na primeira entrega. Numa reentrega at-least-once o INSERT
   * conflita com a linha já commitada e devolve `false` — é isso que impede o
   * mesmo handler de aplicar o efeito duas vezes. Gravar o registro na MESMA
   * transação do efeito (e não antes dele) faz o par andar junto: se o handler
   * falhar, o savepoint reverte o registro e a próxima tentativa reprocessa.
   */
  async markConsumed(
    context: RequestContext,
    consumerName: string,
    eventId: string,
    executor: Executor = context.transaction,
  ): Promise<boolean> {
    const tx = executor as DatabaseTransaction;
    const inserted = await tx
      .insert(outboxConsumptions)
      .values({ consumerName, eventId, tenantId: context.tenantId })
      .onConflictDoNothing({
        target: [outboxConsumptions.consumerName, outboxConsumptions.eventId],
      })
      .returning({ eventId: outboxConsumptions.eventId });
    return inserted.length === 1;
  }

  /** Fecha o evento com `processed_at` no relógio do banco. */
  async markProcessed(
    context: RequestContext,
    eventId: string,
    executor: Executor = context.transaction,
  ): Promise<boolean> {
    const tx = executor as DatabaseTransaction;
    const updated = await tx
      .update(outboxEvents)
      .set({ status: "processed", processedAt: sql`now()`, lastError: null })
      .where(and(eq(outboxEvents.tenantId, context.tenantId), eq(outboxEvents.id, eventId)))
      .returning({ id: outboxEvents.id });
    return updated.length === 1;
  }

  /**
   * Devolve o evento à fila com `failed`, `last_error` e `available_at` no
   * futuro (backoff). Quando `attempts` atinge `maxAttempts` o predicado do
   * claim deixa de alcançá-lo: sem retry infinito, a linha fica para inspeção.
   */
  async markFailed(
    context: RequestContext,
    eventId: string,
    failure: { error: string; backoffMs: number },
    executor: Executor = context.transaction,
  ): Promise<boolean> {
    const tx = executor as DatabaseTransaction;
    const updated = await tx
      .update(outboxEvents)
      .set({
        status: "failed",
        lastError: failure.error,
        availableAt: sql`now() + make_interval(secs => ${failure.backoffMs / 1000}::double precision)`,
      })
      .where(and(eq(outboxEvents.tenantId, context.tenantId), eq(outboxEvents.id, eventId)))
      .returning({ id: outboxEvents.id });
    return updated.length === 1;
  }

  /**
   * Contrato M-04 `EventRepositoryPort.publishPending`: drena o lote pendente do
   * tenant corrente pelo dispatcher injetado e devolve quantos eventos foram
   * processados. Sem dispatcher configurado falha alto — marcar eventos como
   * publicados sem consumidor perderia a fila em silêncio.
   */
  async publishPending(context: RequestContext, executor?: Executor): Promise<number> {
    const dispatcher = this.dispatcher;
    if (!dispatcher) {
      throw new ApplicationError("DEPENDENCY_ERROR", {
        message: "Outbox sem dispatcher configurado: injete um OutboxWorker na composição.",
      });
    }
    return dispatcher.publishPending(context, executor);
  }
}

/** Instância de aplicação: o append do domínio usa esta fila. */
export const outboxRepository = new DrizzleOutboxRepository();
