import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import type { RequestContext } from "@/lib/request-context";
import {
  DefaultPurchasePriceService,
  type PurchasePriceService,
} from "@/server/services/purchase-price.service";
import type {
  PurchasePriceHistoryWrite,
  PurchasePriceRepository,
} from "@/server/repositories/purchase-price.repository";
import { DrizzlePurchasePriceRepository } from "@/server/repositories/purchase-price.repository";
import type { PurchasePriceHistory } from "@/db/schema";
import { contextWithRole } from "./helpers/request-context";

class FakePurchasePriceRepository implements PurchasePriceRepository {
  lastInput: PurchasePriceHistoryWrite | undefined;
  events: string[] = [];

  async append(_context: RequestContext, input: PurchasePriceHistoryWrite) {
    this.events.push("append");
    this.lastInput = input;
    return {
      id: "70000000-0000-4000-8000-000000000007",
    } as PurchasePriceHistory;
  }

  async lock(
    _context: RequestContext,
    _input: { kind: PurchasePriceHistoryWrite["kind"]; subjectId: string },
  ): Promise<void> {
    this.events.push("lock");
  }
}

class FakePurchasePriceTransaction {
  events: string[] = [];
  lockQueries: SQL[] = [];
  rows: PurchasePriceHistory[] = [];

  async execute(query: SQL) {
    this.events.push("lock");
    this.lockQueries.push(query);
    return { rows: [] };
  }

  select() {
    this.events.push("select");
    return {
      from: (_table: unknown) => ({
        where: (_predicate: unknown) => ({
          orderBy: (..._orderBy: unknown[]) => ({
            limit: async (_limit: number) => {
              this.events.push("latest");
              return this.rows.length ? [this.rows[this.rows.length - 1]] : [];
            },
          }),
        }),
      }),
    };
  }

  insert() {
    this.events.push("insert");
    return {
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          const row = {
            id: `history-${this.rows.length + 1}`,
            ...values,
          } as PurchasePriceHistory;
          this.rows.push(row);
          return [row];
        },
      }),
    };
  }
}

describe("PurchasePriceService", () => {
  it("normaliza preço/quantidade e mantém metadados no histórico", async () => {
    const repository = new FakePurchasePriceRepository();
    const service: PurchasePriceService = new DefaultPurchasePriceService(repository);

    await service.append(contextWithRole("owner"), {
      kind: "ingredient",
      subjectId: "80000000-0000-4000-8000-000000000008",
      price: "12.3",
      quantity: "1.25",
      unit: " kg ",
      validFrom: new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(repository.lastInput).toMatchObject({
      price: "12.3000",
      quantity: "1.250000",
      unit: "kg",
    });
  });

  it("rejeita quantidade ausente/inválida e preserva autorização", async () => {
    const service = new DefaultPurchasePriceService(new FakePurchasePriceRepository());
    const input = {
      kind: "ingredient" as const,
      subjectId: "80000000-0000-4000-8000-000000000008",
      price: "12",
      quantity: "0",
      unit: "kg",
      validFrom: new Date(),
    };

    await expect(service.append(contextWithRole("owner"), input)).rejects.toThrow(
      "INVALID_PRICE_QUANTITY",
    );
    await expect(
      service.append(contextWithRole("member"), { ...input, quantity: "1" }),
    ).rejects.toThrow("Você não pode realizar esta ação.");
  });

  it("adquire o advisory lock ANTES do UPDATE da linha base (lock ordering)", async () => {
    const events: string[] = [];
    const repository: PurchasePriceRepository = {
      async append() {
        events.push("append");
        return { id: "70000000-0000-4000-8000-000000000007" } as PurchasePriceHistory;
      },
      async lock() {
        events.push("lock");
      },
    };
    const transaction = {
      update: (_table: unknown) => {
        events.push("update");
        return {
          set: (_values: Record<string, unknown>) => ({
            where: (_predicate: unknown) => ({
              returning: async () => [
                {
                  id: "80000000-0000-4000-8000-000000000008",
                  packagePrice: "12.3000",
                  priceUpdatedAt: new Date("2026-08-15T12:00:00.000Z"),
                },
              ],
            }),
          }),
        };
      },
    };
    const context = {
      ...contextWithRole("owner"),
      transaction: transaction as unknown as RequestContext["transaction"],
    };
    const service = new DefaultPurchasePriceService(repository);

    const result = await service.update(context, {
      kind: "ingredient",
      subjectId: "80000000-0000-4000-8000-000000000008",
      price: "12.3",
      quantity: "1",
      unit: "kg",
    });

    expect(events).toEqual(["lock", "update", "append"]);
    expect(result.historyId).toBe("70000000-0000-4000-8000-000000000007");
  });
});

describe("DrizzlePurchasePriceRepository", () => {
  it("serializa por tenant/kind/subject e deduplica somente o mesmo valor efetivo", async () => {
    const transaction = new FakePurchasePriceTransaction();
    const context = {
      ...contextWithRole("owner"),
      transaction: transaction as unknown as RequestContext["transaction"],
    };
    const repository = new DrizzlePurchasePriceRepository();
    const baseInput: PurchasePriceHistoryWrite = {
      kind: "ingredient",
      subjectId: "80000000-0000-4000-8000-000000000008",
      price: "12.3000",
      quantity: "1.250000",
      unit: "kg",
      validFrom: new Date("2026-08-15T12:00:00.000Z"),
    };

    const first = await repository.append(context, baseInput);
    const duplicate = await repository.append(context, {
      ...baseInput,
      validFrom: new Date("2026-08-15T12:01:00.000Z"),
    });
    const changed = await repository.append(context, {
      ...baseInput,
      price: "13.3000",
      validFrom: new Date("2026-08-15T12:02:00.000Z"),
    });

    const lockQuery = new PgDialect().sqlToQuery(transaction.lockQueries[0]!);
    expect(lockQuery.sql.replace(/\s+/g, " ").trim()).toBe(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    );
    expect(lockQuery.params).toEqual([
      "50000000-0000-4000-8000-000000000005:ingredient:80000000-0000-4000-8000-000000000008",
    ]);
    expect(transaction.events).toEqual([
      "lock",
      "select",
      "latest",
      "insert",
      "lock",
      "select",
      "latest",
      "lock",
      "select",
      "latest",
      "insert",
    ]);
    expect(duplicate.id).toBe(first.id);
    expect(changed.id).not.toBe(first.id);
    expect(transaction.rows).toHaveLength(2);
  });
});
