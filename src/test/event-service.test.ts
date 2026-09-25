import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Expense } from "@/db/schema";
import { ApplicationError } from "@/lib/api-error";
import type { RequestContext } from "@/lib/request-context";
import type {
  AppendEventResult,
  DomainEventInput,
  EventRepositoryPort,
  Executor,
} from "@/server/contracts/event.contracts";
import type {
  ExpenseRepository,
  ExpenseTotals,
  ExpenseWrite,
} from "@/server/repositories/expense.repository";
import { DefaultExpenseService } from "@/server/services/expense.service";
import {
  DefaultEventService,
  eventService,
  type EventService,
} from "@/server/services/event.service";
import { contextWithRole } from "./helpers/request-context";

const EXPENSE_ID = "0e000000-0000-4000-8000-000000000001";

const INPUT: DomainEventInput = {
  eventType: "expense.saved",
  aggregateType: "expense",
  aggregateId: EXPENSE_ID,
  idempotencyKey: `expense.saved:${EXPENSE_ID}:v1`,
  payload: { expenseId: EXPENSE_ID, amount: "10.0000" },
  occurredAt: new Date("2026-09-16T12:00:00.000Z"),
};

const APPENDED: AppendEventResult = {
  eventId: "0e100000-0000-4000-8000-000000000002",
  duplicate: false,
};

/** Fake do port M-04: registra cada chamada e devolve/derruba sob demanda. */
class FakeEventRepository implements EventRepositoryPort {
  readonly appends: Array<{
    context: RequestContext;
    input: DomainEventInput;
    executor?: Executor;
  }> = [];
  readonly publishes: Array<{ context: RequestContext; executor?: Executor }> = [];
  result: AppendEventResult = APPENDED;
  published = 2;
  failAppendWith: unknown;
  failPublishWith: unknown;

  async append(
    context: RequestContext,
    input: DomainEventInput,
    executor?: Executor,
  ): Promise<AppendEventResult> {
    this.appends.push({ context, input, executor });
    if (this.failAppendWith) throw this.failAppendWith;
    return this.result;
  }

  async publishPending(context: RequestContext, executor?: Executor): Promise<number> {
    this.publishes.push({ context, executor });
    if (this.failPublishWith) throw this.failPublishWith;
    return this.published;
  }
}

class FakeExpenseRepository implements ExpenseRepository {
  saves: Array<{ context: RequestContext; input: ExpenseWrite }> = [];
  saved: Expense = {
    id: EXPENSE_ID,
    tenantId: "50000000-0000-4000-8000-000000000005",
    userId: "user-1",
    name: "Aluguel",
    category: "estrutura",
    amount: "10.0000",
    type: "fixa",
    periodicity: "mensal",
    isDemo: false,
    notes: null,
    version: 1,
    createdAt: new Date("2026-09-16T11:00:00.000Z"),
    updatedAt: new Date("2026-09-16T12:00:00.000Z"),
  };

  async list(): Promise<Expense[]> {
    return [];
  }

  async save(context: RequestContext, input: ExpenseWrite): Promise<Expense> {
    this.saves.push({ context, input });
    return this.saved;
  }

  async remove(): Promise<void> {}

  async totals(): Promise<ExpenseTotals> {
    return { fixed: "0.0000", variable: "0.0000", productCount: 0 };
  }
}

const EXPENSE_WRITE: ExpenseWrite = {
  name: "Aluguel",
  category: "estrutura",
  amount: "10.0000",
  type: "fixa",
  periodicity: "mensal",
  notes: null,
};

describe("EventService — caso de uso dos eventos de domínio sobre o port", () => {
  it("a instância de aplicação é a classe padrão sobre o port injetável", () => {
    expect(eventService).toBeInstanceOf(DefaultEventService);
  });

  it("append usa o executor da transação do domínio quando nenhum é informado", async () => {
    const repository = new FakeEventRepository();
    const service: EventService = new DefaultEventService(repository);
    const context = contextWithRole("owner");

    const appended = await service.append(context, INPUT);

    expect(repository.appends).toHaveLength(1);
    expect(repository.appends[0]?.context).toBe(context);
    expect(repository.appends[0]?.input).toEqual(INPUT);
    expect(repository.appends[0]?.executor).toBe(context.transaction);
    expect(appended).toEqual(APPENDED);
  });

  it("append honra o executor explícito (transação/savepoint do chamador)", async () => {
    const repository = new FakeEventRepository();
    const service = new DefaultEventService(repository);
    const context = contextWithRole("owner");
    const executor = { marker: "savepoint" } as unknown as Executor;

    await service.append(context, INPUT, executor);

    expect(repository.appends[0]?.executor).toBe(executor);
    expect(repository.appends[0]?.executor).not.toBe(context.transaction);
  });

  it("append propaga a falha do port — não engole nem repete a chamada", async () => {
    const failure = new ApplicationError("DEPENDENCY_ERROR", { message: "append indisponível" });
    const repository = new FakeEventRepository();
    repository.failAppendWith = failure;
    const service = new DefaultEventService(repository);

    await expect(service.append(contextWithRole("owner"), INPUT)).rejects.toBe(failure);
    expect(repository.appends).toHaveLength(1);
  });

  it("publishPending usa o executor da transação e devolve a contagem drenada", async () => {
    const repository = new FakeEventRepository();
    const service = new DefaultEventService(repository);
    const context = contextWithRole("owner");

    await expect(service.publishPending(context)).resolves.toBe(repository.published);

    expect(repository.publishes).toHaveLength(1);
    expect(repository.publishes[0]?.context).toBe(context);
    expect(repository.publishes[0]?.executor).toBe(context.transaction);
  });

  it("publishPending honra o executor explícito", async () => {
    const repository = new FakeEventRepository();
    const service = new DefaultEventService(repository);
    const executor = { marker: "savepoint" } as unknown as Executor;

    await service.publishPending(contextWithRole("owner"), executor);

    expect(repository.publishes[0]?.executor).toBe(executor);
  });

  it("publishPending propaga o erro do dispatcher — não engole a falha", async () => {
    const failure = new ApplicationError("DEPENDENCY_ERROR", {
      message: "Outbox sem dispatcher configurado",
    });
    const repository = new FakeEventRepository();
    repository.failPublishWith = failure;
    const service = new DefaultEventService(repository);

    await expect(service.publishPending(contextWithRole("owner"))).rejects.toBe(failure);
    expect(repository.publishes).toHaveLength(1);
  });
});

describe("INV-004 — o serviço de eventos não carrega regra financeira", () => {
  it("não importa o motor financeiro nem abre SQL direto", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/server/services/event.service.ts"),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1] ?? "",
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => /financ/i.test(specifier))).toEqual([]);
    expect(
      specifiers.filter(
        (specifier) => specifier.startsWith("@/db/") || specifier.startsWith("drizzle-orm"),
      ),
    ).toEqual([]);
  });
});

describe("expense.service -> EventService — mesma transação do domínio", () => {
  it("um save appenda o evento uma única vez no executor da transação corrente", async () => {
    const events = new FakeEventRepository();
    const expenses = new FakeExpenseRepository();
    const service = new DefaultExpenseService(expenses, new DefaultEventService(events));
    const context = contextWithRole("owner");

    const saved = await service.save(context, EXPENSE_WRITE);

    expect(saved).toBe(expenses.saved);
    expect(events.appends).toHaveLength(1);
    expect(events.appends[0]?.context).toBe(context);
    expect(events.appends[0]?.executor).toBe(context.transaction);
    expect(events.appends[0]?.input).toMatchObject({
      eventType: "expense.saved",
      aggregateType: "expense",
      aggregateId: saved.id,
      idempotencyKey: `expense.saved:${saved.id}:v${saved.version}`,
      occurredAt: saved.updatedAt,
      payload: {
        expenseId: saved.id,
        name: saved.name,
        amount: saved.amount,
        type: saved.type,
        version: saved.version,
      },
    });
  });

  it("falha do append derruba o save (não é engolida)", async () => {
    const failure = new ApplicationError("DEPENDENCY_ERROR", { message: "outbox indisponível" });
    const events = new FakeEventRepository();
    events.failAppendWith = failure;
    const expenses = new FakeExpenseRepository();
    const service = new DefaultExpenseService(expenses, new DefaultEventService(events));

    await expect(service.save(contextWithRole("owner"), EXPENSE_WRITE)).rejects.toBe(failure);
    expect(expenses.saves).toHaveLength(1);
  });
});
