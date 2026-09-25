import { idempotencyRecords, products, toolExecutions } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

/**
 * Fakes compartilhados por `tool-runner.persistence.test.ts` e
 * `safe-record.test.ts`: nenhum dos dois toca PostgreSQL.
 */
export const tenantId = "72000000-0000-4000-8000-000000000002";
export const userId = "71000000-0000-4000-8000-000000000001";
export const correlationId = "76000000-0000-4000-8000-000000000006";
export const usageId = "78000000-0000-4000-8000-000000000008";

interface WrittenRow {
  table: unknown;
  values: Record<string, unknown>;
}

/** Fake transaction ladder: registra values/set e devolve rows mínimos por tabela. */
export class FakeTransaction {
  private readonly inserts: WrittenRow[] = [];
  private readonly updates: WrittenRow[] = [];
  private claimCounter = 0;
  private executionCounter = 0;
  private rateLimitDenied = false;

  insertsFor(table: unknown): Record<string, unknown>[] {
    return this.inserts.filter((row) => row.table === table).map((row) => row.values);
  }

  updatesFor(table: unknown): Record<string, unknown>[] {
    return this.updates.filter((row) => row.table === table).map((row) => row.values);
  }

  private rowsFor(table: unknown): Record<string, unknown>[] {
    if (table === idempotencyRecords) {
      this.claimCounter += 1;
      return [{ id: `00000000-0000-4000-8000-00000000000${this.claimCounter}` }];
    }
    if (table === toolExecutions) {
      this.executionCounter += 1;
      return [{ id: `10000000-0000-4000-8000-00000000000${this.executionCounter}` }];
    }
    if (table === products) {
      return [{ id: "20000000-0000-4000-8000-000000000001", name: "Bolo" }];
    }
    return [];
  }

  insert(table: unknown) {
    return {
      values: (values: Record<string, unknown>) => {
        this.inserts.push({ table, values });
        const rows = Promise.resolve(this.rowsFor(table));
        return Object.assign(rows, {
          onConflictDoNothing: () => ({ returning: () => rows }),
          returning: () => rows,
        });
      },
    };
  }

  update(table: unknown) {
    return {
      set: (values: Record<string, unknown>) => {
        this.updates.push({ table, values });
        return { where: () => Promise.resolve() };
      },
    };
  }

  select() {
    return {
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    };
  }

  async execute() {
    // Resposta do bucket de rate limit: linha de contador aprovado por padrão.
    return this.rateLimitDenied ? { rows: [] } : { rows: [{ count: 1, last_request: Date.now() }] };
  }

  /** Simula o bucket saturado: o UPDATE condicional não devolve linha. */
  denyRateLimit(): void {
    this.rateLimitDenied = true;
  }
}

export function fakeContext(
  transaction: FakeTransaction,
  roles: string[] = ["owner"],
): RequestContext {
  return {
    userId,
    tenantId,
    roles,
    correlationId,
    signal: new AbortController().signal,
    // SAFETY: same boundary as scripts/db/test-tool-security.ts - the app-facing
    // `RequestContext.transaction` is an opaque handle, and this helper hands it a
    // fake transaction that satisfies the query surface the runner uses.
    transaction: transaction as unknown as RequestContext["transaction"],
  };
}
