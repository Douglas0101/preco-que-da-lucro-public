import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import type { RequestContext } from "@/lib/request-context";
import { DrizzleProductRepository } from "@/server/repositories/product.repository";
import { DrizzleExpenseRepository } from "@/server/repositories/expense.repository";
import { contextWithRole } from "./helpers/request-context";

const PRODUCT_ID = "50000000-0000-4000-8000-000000000005";
const EXPENSE_ID = "50000000-0000-4000-8000-00000000000e";

class FakeWriteTransaction {
  events: string[] = [];
  updateSet: Record<string, unknown> | undefined;
  insertValues: Record<string, unknown> | undefined;
  whereQueries: SQL[] = [];
  updateRows: unknown[] = [];
  existingRows: unknown[] = [];
  insertedRows: unknown[] = [];

  update(_table: unknown) {
    this.events.push("update");
    return {
      set: (values: Record<string, unknown>) => {
        this.updateSet = values;
        return {
          where: (predicate: SQL) => {
            this.whereQueries.push(predicate);
            return { returning: async () => this.updateRows };
          },
        };
      },
    };
  }

  select(_fields?: unknown) {
    this.events.push("select");
    return {
      from: (_table: unknown) => ({
        where: (predicate: SQL) => {
          this.whereQueries.push(predicate);
          return { limit: async (_limit: number) => this.existingRows };
        },
      }),
    };
  }

  insert(_table: unknown) {
    this.events.push("insert");
    return {
      values: (values: Record<string, unknown>) => {
        this.insertValues = values;
        return { returning: async () => this.insertedRows };
      },
    };
  }
}

function contextWithTransaction(transaction: FakeWriteTransaction): RequestContext {
  return {
    ...contextWithRole("owner"),
    transaction: transaction as unknown as RequestContext["transaction"],
  };
}

function renderWhere(query: SQL): { sql: string; params: unknown[] } {
  const rendered = new PgDialect().sqlToQuery(query);
  return { sql: rendered.sql.replace(/\s+/g, " ").trim(), params: rendered.params };
}

describe("ProductRepository — CAS otimista (T2)", () => {
  it("update com version esperada incrementa via version + 1 no WHERE tenant+id+version", async () => {
    const transaction = new FakeWriteTransaction();
    transaction.updateRows = [{ id: PRODUCT_ID, tenantId: "t", version: 4 }];
    const repository = new DrizzleProductRepository();

    const row = await repository.save(contextWithTransaction(transaction), {
      id: PRODUCT_ID,
      version: 3,
      name: "Bolo",
      currentPrice: "10.0000",
      yieldQty: "1.000000",
      yieldUnit: "unidade",
      taxRegime: null,
      taxRate: null,
    });

    expect(row.version).toBe(4);
    expect(transaction.events).toEqual(["update"]);
    const where = renderWhere(transaction.whereQueries[0]!);
    expect(where.sql).toContain('"products"."tenant_id" = $1');
    expect(where.sql).toContain('"products"."id" = $2');
    expect(where.sql).toContain('"products"."version" = $3');
    expect(where.params).toEqual(["50000000-0000-4000-8000-000000000005", PRODUCT_ID, 3]);

    const increment = new PgDialect().sqlToQuery(transaction.updateSet!.version as SQL);
    expect(increment.sql.replace(/\s+/g, " ").trim()).toBe('"products"."version" + 1');
    expect(increment.params).toEqual([]);
  });

  it("0 linhas com registro existente → CONFLICT (409)", async () => {
    const transaction = new FakeWriteTransaction();
    transaction.updateRows = [];
    transaction.existingRows = [{ id: PRODUCT_ID }];
    const repository = new DrizzleProductRepository();

    await expect(
      repository.save(contextWithTransaction(transaction), {
        id: PRODUCT_ID,
        version: 3,
        name: "Bolo",
        currentPrice: null,
        yieldQty: null,
        yieldUnit: null,
        taxRegime: null,
        taxRate: null,
      }),
    ).rejects.toThrow("CONFLICT");
    expect(transaction.events).toEqual(["update", "select"]);
  });

  it("0 linhas sem registro → NOT_FOUND (404)", async () => {
    const transaction = new FakeWriteTransaction();
    transaction.updateRows = [];
    transaction.existingRows = [];
    const repository = new DrizzleProductRepository();

    await expect(
      repository.save(contextWithTransaction(transaction), {
        id: PRODUCT_ID,
        version: 0,
        name: "Bolo",
        currentPrice: null,
        yieldQty: null,
        yieldUnit: null,
        taxRegime: null,
        taxRate: null,
      }),
    ).rejects.toThrow("NOT_FOUND");
  });

  it("update sem version → VALIDATION_ERROR sem tocar o banco", async () => {
    const transaction = new FakeWriteTransaction();
    const repository = new DrizzleProductRepository();

    await expect(
      repository.save(contextWithTransaction(transaction), {
        id: PRODUCT_ID,
        name: "Bolo",
        currentPrice: null,
        yieldQty: null,
        yieldUnit: null,
        taxRegime: null,
        taxRate: null,
      }),
    ).rejects.toThrow("VALIDATION_ERROR");
    expect(transaction.events).toEqual([]);
  });

  it("create omite version (default 0 do banco)", async () => {
    const transaction = new FakeWriteTransaction();
    transaction.insertedRows = [{ id: PRODUCT_ID, tenantId: "t", version: 0 }];
    const repository = new DrizzleProductRepository();

    const row = await repository.save(contextWithTransaction(transaction), {
      name: "Bolo novo",
      currentPrice: null,
      yieldQty: null,
      yieldUnit: null,
      taxRegime: null,
      taxRate: null,
    });

    expect(row.version).toBe(0);
    expect(transaction.events).toEqual(["insert"]);
    expect(Object.hasOwn(transaction.insertValues ?? {}, "version")).toBe(false);
  });
});

describe("ExpenseRepository — CAS otimista (T2)", () => {
  it("update com version esperada incrementa via version + 1 no WHERE tenant+id+version", async () => {
    const transaction = new FakeWriteTransaction();
    transaction.updateRows = [{ id: EXPENSE_ID, tenantId: "t", version: 2 }];
    const repository = new DrizzleExpenseRepository();

    const row = await repository.save(contextWithTransaction(transaction), {
      id: EXPENSE_ID,
      version: 1,
      name: "Aluguel",
      category: null,
      amount: "1200.0000",
      type: "fixa",
      periodicity: "mensal",
      notes: null,
    });

    expect(row.version).toBe(2);
    const where = renderWhere(transaction.whereQueries[0]!);
    expect(where.sql).toContain('"expenses"."version" = $3');
    expect(where.params).toEqual(["50000000-0000-4000-8000-000000000005", EXPENSE_ID, 1]);
    const increment = new PgDialect().sqlToQuery(transaction.updateSet!.version as SQL);
    expect(increment.sql.replace(/\s+/g, " ").trim()).toBe('"expenses"."version" + 1');
  });

  it("0 linhas com registro existente → CONFLICT e sem registro → NOT_FOUND", async () => {
    const conflict = new FakeWriteTransaction();
    conflict.updateRows = [];
    conflict.existingRows = [{ id: EXPENSE_ID }];
    const repository = new DrizzleExpenseRepository();

    const input = {
      id: EXPENSE_ID,
      version: 5,
      name: "Aluguel",
      category: null,
      amount: "1200.0000",
      type: "fixa" as const,
      periodicity: "mensal",
      notes: null,
    };
    await expect(repository.save(contextWithTransaction(conflict), input)).rejects.toThrow(
      "CONFLICT",
    );

    const notFound = new FakeWriteTransaction();
    notFound.updateRows = [];
    notFound.existingRows = [];
    await expect(repository.save(contextWithTransaction(notFound), input)).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("create omite version e update sem version → VALIDATION_ERROR", async () => {
    const transaction = new FakeWriteTransaction();
    transaction.insertedRows = [{ id: EXPENSE_ID, tenantId: "t", version: 0 }];
    const repository = new DrizzleExpenseRepository();

    const row = await repository.save(contextWithTransaction(transaction), {
      name: "Luz",
      category: null,
      amount: "80.0000",
      type: "variavel",
      periodicity: "mensal",
      notes: null,
    });
    expect(row.version).toBe(0);
    expect(Object.hasOwn(transaction.insertValues ?? {}, "version")).toBe(false);

    await expect(
      repository.save(contextWithTransaction(transaction), {
        id: EXPENSE_ID,
        name: "Luz",
        category: null,
        amount: "80.0000",
        type: "variavel",
        periodicity: "mensal",
        notes: null,
      }),
    ).rejects.toThrow("VALIDATION_ERROR");
  });
});
