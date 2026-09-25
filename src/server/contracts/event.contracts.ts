/**
 * PLANNED — alvo M-04 (outbox de domínio / EventService).
 *
 * Contratos somente-tipo copiados verbatim de `docs/specs/M-04/spec.md:231-254`.
 * Sem runtime: nenhum valor, nenhum import de `@/db` ou `drizzle-orm`. O
 * repositório concreto chega com M-04; até lá a matrix M-02 mantém
 * `EventService`/`EventRepository` como `contract-only`.
 */
import type { RequestContext } from "@/lib/request-context";

/** Unidade de trabalho aceita pelos ports de repositório (M02-D-003): o handle
 * transacional do RequestContext. Alias estrutural mantém este arquivo livre de
 * import de `@/db`. */
export type Executor = RequestContext["transaction"];

export interface DomainEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface AppendEventResult {
  eventId: string;
  duplicate: boolean;
}

export interface EventRepositoryPort {
  append(
    context: RequestContext,
    input: DomainEventInput,
    executor?: Executor,
  ): Promise<AppendEventResult>;
  publishPending(context: RequestContext, executor?: Executor): Promise<number>;
}
