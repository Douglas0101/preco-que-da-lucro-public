import { Pool as NeonPool } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool as NodePostgresPool } from "pg";
import * as schema from "@/db/schema";
import { ApplicationError } from "@/lib/api-error";
import { logJson } from "@/lib/structured-logger";
import { normalizeSqlOperation, redactSqlText } from "@/instrumentation/sql-redactor";
import { recordSafely } from "@/instrumentation/safe-record";
import {
  applicationMetrics,
  endSpanWithResult,
  registerPoolSnapshotSource,
  startDatabaseQuerySpan,
  withSpan,
  type DatabasePoolSnapshot,
} from "@/instrumentation/telemetry";

function createNeonDatabase(connectionString: string) {
  // Teto explícito; 901 max_connections medidos no plano (Fase 0.3); default 10 preserva o comportamento atual.
  const pool = new NeonPool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
  });
  instrumentPoolRoundTrips(pool, "neon-serverless");
  return drizzleNeon({ client: pool, schema });
}

export type Database = ReturnType<typeof createNeonDatabase>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseIdentity {
  userId: string;
  tenantId: string;
  roles: readonly string[];
}

export interface ResolvedTenantMembership {
  tenantId: string;
  role: string;
}

/** Raised inside the context transaction when membership verification fails.
 * The transaction rolls back; the middleware maps it to a 403 response. */
export class TenantMembershipDeniedError extends ApplicationError {
  constructor() {
    super("AUTHORIZATION_ERROR");
    this.name = "TenantMembershipDeniedError";
  }
}

export interface TransactionManager {
  run<T>(
    identity: DatabaseIdentity,
    operation: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}

let database: Database | undefined;

function createDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL não configurada");
  }

  const driver = process.env.DATABASE_DRIVER ?? "neon-serverless";
  if (driver === "node-postgres") {
    // CI and local integration tests use a regular ephemeral PostgreSQL server.
    // Production remains on Neon pooled through @neondatabase/serverless.
    // Teto explícito; 901 max_connections medidos no plano (Fase 0.3); default 10 preserva o comportamento atual.
    const pool = new NodePostgresPool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
    });
    instrumentPoolRoundTrips(pool, "node-postgres");
    // SAFETY: both driver branches of `createDatabase` must expose the same
    // operations the locally-declared `Database` interface requires (the query
    // surface used by repositories plus `transaction`). The node-postgres
    // drizzle instance does satisfy them, but TypeScript cannot unify the two
    // driver-specific factory return types with that hand-written interface, so
    // this cast is the single place where cross-driver structural compatibility
    // is asserted. FRAGILE: if a repository starts using an operation that only
    // one driver provides, this cast would hide the divergence until runtime -
    // the two driver paths are the guard.
    return drizzleNodePostgres({ client: pool, schema }) as unknown as Database;
  }
  if (driver !== "neon-serverless") {
    throw new Error("DATABASE_DRIVER deve ser neon-serverless ou node-postgres");
  }
  return createNeonDatabase(connectionString);
}

export function getDatabase(): Database {
  database ??= createDatabase();
  return database;
}

export function setDatabaseForTests(value: Database | undefined): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("A injeção de banco é proibida em produção");
  }
  database = value;
}

/**
 * Every tenant operation runs in one short transaction. The GUC values feed
 * PostgreSQL RLS while repositories must still include tenant_id explicitly.
 */
export async function withTenantTransaction<T>(
  identity: DatabaseIdentity,
  operation: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await withSpan(
      "db.tenant_transaction",
      { "db.system.name": "postgresql", "app.tenant_id": identity.tenantId },
      () =>
        getDatabase().transaction(async (transaction) => {
          await transaction.execute(sql`
            select
              set_config('app.current_user_id', ${identity.userId}, true),
              set_config('app.current_tenant_id', ${identity.tenantId}, true),
              set_config('app.current_roles', ${identity.roles.join(",")}, true)
          `);

          return operation(transaction);
        }),
    );
  } finally {
    recordTransactionDuration(performance.now() - startedAt);
  }
}

/**
 * Single short transaction that resolves membership BEFORE any tenant GUC is
 * applied (INV-002/010) and only then runs the operation with tenant GUCs set
 * for RLS. Consolidates the previous two-transaction flow (membership tx +
 * tenant tx) to remove the fixed per-request round-trip tax.
 */
export async function withResolvedTenantTransaction<T>(
  userId: string,
  resolveMembership: (
    transaction: DatabaseTransaction,
  ) => Promise<ResolvedTenantMembership | undefined>,
  operation: (transaction: DatabaseTransaction, membership: ResolvedTenantMembership) => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await withSpan("db.tenant_transaction", { "db.system.name": "postgresql" }, (span) =>
      getDatabase().transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
        const membership = await resolveMembership(transaction);
        if (!membership) throw new TenantMembershipDeniedError();
        span.setAttribute("app.tenant_id", membership.tenantId);
        await transaction.execute(sql`
          select
            set_config('app.current_tenant_id', ${membership.tenantId}, true),
            set_config('app.current_roles', ${membership.role}, true)
        `);
        return operation(transaction, membership);
      }),
    );
  } finally {
    recordTransactionDuration(performance.now() - startedAt);
  }
}

/** Public application boundary for short tenant transactions. Keeping this
 * interface beside the existing primitive allows services to depend on a
 * transaction manager without opening nested transactions. */
export const transactionManager: TransactionManager = {
  run: withTenantTransaction,
};

const instrumentedClients = new WeakSet<object>();
const instrumentedPools = new WeakMap<object, InstrumentedPool>();

type PoolClientHooks = {
  onTransactionBegin?: () => void;
  onTransactionEnd?: () => void;
};

export interface InstrumentedPool {
  read(): DatabasePoolSnapshot;
  unregister(): void;
}

function statementText(statement: unknown): string | undefined {
  if (typeof statement === "string") return statement;
  if (statement && typeof statement === "object" && "text" in statement) {
    const text = (statement as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function transactionBoundary(statement: unknown): "begin" | "commit" | "rollback" | undefined {
  const text = statementText(statement)?.trim().toLowerCase();
  if (text === "begin" || text?.startsWith("begin ")) return "begin";
  if (text === "commit" || text?.startsWith("commit ")) return "commit";
  if (text === "rollback") return "rollback";
  return undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Span por query com semconv PostgreSQL; `values` nunca é anexado. */
function createQuerySpan(statement: unknown) {
  const text = statementText(statement);
  const operation = normalizeSqlOperation(text);
  const redacted = text === undefined ? undefined : redactSqlText(text);
  return { span: startDatabaseQuerySpan(operation, redacted), operation };
}

/** Métrica de query: um `record` que lança nunca pode rejeitar uma query que
 * já teve sucesso nem pular o callback do usuário (mesma regra defensiva dos
 * observables do pool em `telemetry.ts`). */
function recordQueryDuration(operation: string, durationMs: number): void {
  recordSafely(applicationMetrics.dbQueryDuration, durationMs, {
    "db.operation.name": operation,
    "db.system.name": "postgresql",
  });
}

/** Métrica de duração de `db.tenant_transaction`: um `record` que lança no
 * `finally` não pode rejeitar uma transação já commitada nem substituir o erro
 * real (inclusive `TenantMembershipDeniedError`). */
function recordTransactionDuration(durationMs: number): void {
  recordSafely(applicationMetrics.dbDuration, durationMs);
}

/** Métrica de espera por cliente do pool: o `pg-pool` invoca o callback de
 * `connect` sem try/catch, então um `record` que lança viraria
 * `uncaughtException` e deixaria o cliente preso fora do pool — a query nunca
 * assenta e o pool esgota. */
function recordPoolWait(durationMs: number, driver: string): void {
  recordSafely(applicationMetrics.dbPoolWaitTime, durationMs, { driver });
}

function instrumentClientRoundTrips(client: unknown, hooks: PoolClientHooks = {}): void {
  const target = client as { query?: (...queryArgs: unknown[]) => unknown } | null;
  if (!target || typeof target.query !== "function" || instrumentedClients.has(target)) {
    return;
  }
  instrumentedClients.add(target);
  const originalQuery = target.query.bind(target);
  let roundTrips = 0;
  let transactionStartedAt = 0;
  target.query = (...queryArgs: unknown[]) => {
    const boundary = transactionBoundary(queryArgs[0]);
    if (boundary === "begin") {
      roundTrips = 0;
      transactionStartedAt = performance.now();
      hooks.onTransactionBegin?.();
    }
    roundTrips += 1;

    const queryStartedAt = performance.now();
    const querySpan = boundary ? undefined : createQuerySpan(queryArgs[0]);
    let spanFinalized = false;
    const finalizeSpan = (error?: unknown) => {
      if (!querySpan || spanFinalized) return;
      spanFinalized = true;
      recordQueryDuration(querySpan.operation, performance.now() - queryStartedAt);
      endSpanWithResult(querySpan.span, error);
    };

    const isEndingBoundary = boundary === "commit" || boundary === "rollback";
    let finalized = false;
    const finalize = (error?: unknown) => {
      if (!isEndingBoundary || finalized) return;
      finalized = true;
      logJson("info", "app.context_tx", {
        round_trips: roundTrips,
        outcome: error ? `${boundary}_failed` : boundary,
        duration_ms: Math.round(
          transactionStartedAt > 0 ? performance.now() - transactionStartedAt : 0,
        ),
      });
      roundTrips = 0;
      transactionStartedAt = 0;
      hooks.onTransactionEnd?.();
    };

    const callbackIndex = queryArgs.findIndex((argument) => typeof argument === "function");
    if (callbackIndex >= 0) {
      const callback = queryArgs[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
      queryArgs[callbackIndex] = (...callbackArgs: unknown[]) => {
        const callbackError = callbackArgs[0] ?? undefined;
        finalize(callbackError);
        finalizeSpan(callbackError);
        return callback(...callbackArgs);
      };
    }

    try {
      const result = originalQuery(...queryArgs);
      if (callbackIndex < 0 && isThenable(result)) {
        return result.then(
          (value) => {
            finalize();
            finalizeSpan();
            return value;
          },
          (error) => {
            finalize(error);
            finalizeSpan(error);
            throw error;
          },
        );
      }
      if (callbackIndex < 0) {
        finalize();
        finalizeSpan();
      }
      return result;
    } catch (error) {
      finalize(error);
      finalizeSpan(error);
      throw error;
    }
  };
}

function readPoolCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function resolvePoolDriver(driver?: string): string {
  if (driver === "neon-serverless" || driver === "node-postgres") return driver;
  return process.env.DATABASE_DRIVER === "node-postgres" ? "node-postgres" : "neon-serverless";
}

/** Counts real round trips per transaction and emits an `app.context_tx` log
 * line on commit/rollback (S1-PERF-TX RT instrumentation, zero dependencies).
 * Também expõe snapshot do pool (§16.7) e spans por query (§19.3) nos dois
 * caminhos de aquisição de cliente: promise (`pool.connect()`) e callback
 * (`pool.connect(cb)` — o caminho que `pool.query` usa e que devolve
 * `undefined`). */
export function instrumentPoolRoundTrips(
  pool: unknown,
  driver?: string,
): InstrumentedPool | undefined {
  const poolLike = pool as
    | ({
        connect?: (...connectArgs: unknown[]) => unknown;
      } & {
        totalCount?: unknown;
        idleCount?: unknown;
        waitingCount?: unknown;
        options?: { max?: unknown };
      })
    | null;
  if (!poolLike || typeof poolLike.connect !== "function") return undefined;
  const existing = instrumentedPools.get(poolLike);
  if (existing) return existing;

  const driverLabel = resolvePoolDriver(driver);
  let inFlightTransactions = 0;
  const snapshotSource = (): DatabasePoolSnapshot => {
    const total = readPoolCount(poolLike.totalCount);
    const idle = readPoolCount(poolLike.idleCount);
    return {
      driver: driverLabel,
      used: Math.max(total - idle, 0),
      idle,
      waiting: readPoolCount(poolLike.waitingCount),
      max: readPoolCount(poolLike.options?.max),
      inFlightTransactions,
    };
  };
  const handle: InstrumentedPool = {
    read: snapshotSource,
    unregister: registerPoolSnapshotSource(snapshotSource),
  };
  instrumentedPools.set(poolLike, handle);

  const originalConnect = poolLike.connect.bind(poolLike);
  const clientHooks: PoolClientHooks = {
    onTransactionBegin: () => {
      inFlightTransactions += 1;
    },
    onTransactionEnd: () => {
      inFlightTransactions = Math.max(0, inFlightTransactions - 1);
    },
  };
  poolLike.connect = (...connectArgs: unknown[]) => {
    const startedAt = performance.now();
    let waitRecorded = false;
    const recordWait = () => {
      if (waitRecorded) return;
      waitRecorded = true;
      recordPoolWait(performance.now() - startedAt, driverLabel);
    };
    const callbackIndex = connectArgs.findIndex((argument) => typeof argument === "function");
    if (callbackIndex >= 0) {
      const callback = connectArgs[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
      connectArgs[callbackIndex] = (...callbackArgs: unknown[]) => {
        recordWait();
        // `pg-pool` adquire o cliente de `pool.query` por este caminho e devolve
        // `undefined` (node_modules/pg-pool/index.js:190,449); sem instrumentar
        // aqui, toda query fora de transação (rate limiter, health, vitals, auth)
        // ficaria sem span. O `instrumentedClients` WeakSet garante um único
        // wrapper por cliente, então o caminho promise abaixo nunca duplica.
        if (!callbackArgs[0]) instrumentClientRoundTrips(callbackArgs[1], clientHooks);
        return callback(...callbackArgs);
      };
    }
    const connected = originalConnect(...connectArgs);
    if (!isThenable(connected)) return connected;
    return connected.then(
      (client) => {
        recordWait();
        instrumentClientRoundTrips(client, clientHooks);
        return client;
      },
      (error) => {
        recordWait();
        throw error;
      },
    );
  };

  return handle;
}
