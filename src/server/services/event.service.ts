/**
 * §9.1 (Application Services) + §23.1/§23.2 — caso de uso dos eventos de domínio.
 *
 * O serviço é a fronteira de aplicação sobre o `EventRepositoryPort` (contrato
 * M-04): o append entra na **transação do domínio** (§23.1 — a mutação e o evento
 * commitam juntos) e o `publishPending` é o ponto de drenagem que o
 * `OutboxWorker` implementa (§23.2). O executor é resolvido aqui, explicitamente
 * a partir de `context.transaction`, para que o chamador não dependa do default
 * do repositório e um savepoint/transação explícita continue possível.
 *
 * Não há regra de negócio aqui: nenhum cálculo financeiro (INV-004), nenhum
 * consumidor, nenhum SQL — a persistência é do repositório.
 */
import type { RequestContext } from "@/lib/request-context";
import type {
  AppendEventResult,
  DomainEventInput,
  EventRepositoryPort,
  Executor,
} from "@/server/contracts/event.contracts";
import { outboxRepository } from "@/server/repositories/outbox.repository";

export interface EventService {
  append(
    context: RequestContext,
    input: DomainEventInput,
    executor?: Executor,
  ): Promise<AppendEventResult>;
  publishPending(context: RequestContext, executor?: Executor): Promise<number>;
}

export class DefaultEventService implements EventService {
  constructor(private readonly repository: EventRepositoryPort = outboxRepository) {}

  append(
    context: RequestContext,
    input: DomainEventInput,
    executor: Executor = context.transaction,
  ): Promise<AppendEventResult> {
    return this.repository.append(context, input, executor);
  }

  publishPending(
    context: RequestContext,
    executor: Executor = context.transaction,
  ): Promise<number> {
    return this.repository.publishPending(context, executor);
  }
}

export const eventService: EventService = new DefaultEventService();
