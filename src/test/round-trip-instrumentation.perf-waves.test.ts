import "./helpers/otel-metrics";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SpanStatusCode, trace, type Attributes, type ObservableResult } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  instrumentPoolRoundTrips,
  setDatabaseForTests,
  TenantMembershipDeniedError,
  withResolvedTenantTransaction,
  withTenantTransaction,
  type Database,
} from "@/db/client.server";
import { SQL_REDACTION_MAX_LENGTH } from "@/instrumentation/sql-redactor";
import {
  aggregatePoolSnapshots,
  applicationMetrics,
  registerPoolSnapshotSource,
  reportPoolConnectionObservations,
  reportPoolInFlightObservations,
  type DatabasePoolSnapshot,
} from "@/instrumentation/telemetry";

interface FakeQueryClient {
  query: (...args: unknown[]) => unknown;
}

interface FakePoolOptions {
  driver?: string;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
  max?: number;
  failOn?: string;
}

const unregisters: Array<() => void> = [];

/** Exportador em memória: sem provider global o tracer é noop e as asserções de
 * atributo passariam em falso. */
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(tracerProvider);
});

/** Spans de query emitidos (todo `db.tenant_transaction` fica de fora). */
function querySpans() {
  return spanExporter.getFinishedSpans().filter((span) => "db.operation.name" in span.attributes);
}

/** Mímica de `pg.Client`: chamado com callback devolve `undefined` e entrega o
 * resultado pelo callback; sem callback devolve a promise. */
function recordingClient(queries: unknown[][], options: FakePoolOptions = {}): FakeQueryClient {
  return {
    query: (...args: unknown[]) => {
      queries.push(args);
      const statement = args[0];
      const text =
        typeof statement === "string"
          ? statement
          : ((statement as { text?: unknown } | undefined)?.text ?? "");
      const callback = args.find((argument) => typeof argument === "function") as
        ((error: unknown, result: unknown) => void) | undefined;
      const failure =
        options.failOn && typeof text === "string" && text.includes(options.failOn)
          ? new Error("syntax error")
          : undefined;
      if (callback) {
        callback(failure, failure ? undefined : { rows: [] });
        return undefined;
      }
      return failure ? Promise.reject(failure) : Promise.resolve({ rows: [] });
    },
  };
}

/** Mímica de `pg.Pool` (`node_modules/pg-pool/index.js:190,431`): `connect(cb)`
 * devolve `undefined` e entrega o cliente pelo callback, e `query` adquire o
 * cliente exatamente por esse caminho — é assim que o
 * `drizzle-orm/node-postgres` roteia toda query fora de transação. */
function createPgPoolLike(client: FakeQueryClient, options: FakePoolOptions = {}) {
  return {
    totalCount: options.totalCount ?? 1,
    idleCount: options.idleCount ?? 1,
    waitingCount: options.waitingCount ?? 0,
    options: { max: options.max ?? 10 },
    connect(cb?: (error: unknown, pooledClient: unknown, release: () => void) => void) {
      if (!cb) return Promise.resolve(client);
      cb(undefined, client, () => undefined);
      return undefined;
    },
    query(text: unknown, valuesOrCallback?: unknown, maybeCallback?: unknown): unknown {
      const callback =
        typeof valuesOrCallback === "function"
          ? (valuesOrCallback as (error: unknown, result: unknown) => void)
          : (maybeCallback as ((error: unknown, result: unknown) => void) | undefined);
      const values = typeof valuesOrCallback === "function" ? undefined : valuesOrCallback;
      if (callback) {
        this.connect((error, pooledClient) => {
          if (error) return callback(error, undefined);
          (pooledClient as FakeQueryClient).query(text, values, callback);
        });
        return undefined;
      }
      return new Promise((resolve, reject) => {
        this.connect((error, pooledClient) => {
          if (error) return reject(error);
          (pooledClient as FakeQueryClient).query(
            text,
            values,
            (queryError: unknown, result: unknown) =>
              queryError ? reject(queryError) : resolve(result),
          );
        });
      });
    },
  };
}

/** Pool no formato do wrapper anterior (connect promise), para os testes de
 * `app.context_tx`/snapshot que já existiam. */
async function instrumentFakePool(options: FakePoolOptions = {}) {
  const events: Record<string, unknown>[] = [];
  vi.spyOn(console, "info").mockImplementation((record: unknown) => {
    events.push(JSON.parse(String(record)) as Record<string, unknown>);
  });
  const queries: unknown[][] = [];
  const client = recordingClient(queries, options);
  const pool = {
    totalCount: options.totalCount ?? 0,
    idleCount: options.idleCount ?? 0,
    waitingCount: options.waitingCount ?? 0,
    options: { max: options.max ?? 10 },
    connect: async () => client,
  };
  const handle = instrumentPoolRoundTrips(pool, options.driver ?? "node-postgres");
  if (handle) unregisters.push(handle.unregister);
  const instrumented = await (pool.connect as () => Promise<FakeQueryClient>)();
  const contextTxEvents = () => events.filter((record) => record.event === "app.context_tx");
  return { instrumented, queries, contextTxEvents, pool, handle };
}

function collectRecordedMetrics() {
  const records: Array<{ value: number; attributes: Record<string, unknown> }> = [];
  const record = (value: number, attributes?: Attributes) => {
    records.push({ value, attributes: (attributes ?? {}) as Record<string, unknown> });
  };
  vi.spyOn(applicationMetrics.dbQueryDuration, "record").mockImplementation(record);
  vi.spyOn(applicationMetrics.dbPoolWaitTime, "record").mockImplementation(record);
  return {
    queryRecords: () => records.filter((record) => "db.operation.name" in record.attributes),
    waitRecords: () => records.filter((record) => "driver" in record.attributes),
  };
}

function recordingObservable() {
  const observations: Array<{ value: number; attributes?: Record<string, unknown> }> = [];
  const result = {
    observe(value: number, attributes?: Record<string, unknown>) {
      observations.push({ value, attributes });
    },
  } as unknown as ObservableResult;
  return { result, observations };
}

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  spanExporter.reset();
  setDatabaseForTests(undefined);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tracerProvider.shutdown();
  trace.disable();
});

describe("T1 perf-waves: instrumentação de round trips por transação (app.context_tx)", () => {
  it("emite round_trips acumulados de begin a commit e reinicia a contagem na próxima transação", async () => {
    const { instrumented, contextTxEvents } = await instrumentFakePool();

    await instrumented.query("begin");
    await instrumented.query("select set_config('app.current_user_id', $1, true)", ["user-1"]);
    await instrumented.query("select set_config('app.current_tenant_id', $1, true)", ["tenant-1"]);
    await instrumented.query("select 1");
    await instrumented.query("commit");
    await instrumented.query("select 2");
    await instrumented.query("begin");
    await instrumented.query("commit");

    const events = contextTxEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ round_trips: 5, outcome: "commit" });
    expect(events[1]).toMatchObject({ round_trips: 2, outcome: "commit" });
  });

  it("emite round_trips em rollback", async () => {
    const { instrumented, contextTxEvents } = await instrumentFakePool();

    await instrumented.query("begin");
    await instrumented.query("select 1");
    await instrumented.query("rollback");

    const events = contextTxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ round_trips: 3, outcome: "rollback" });
  });

  it("instrumenta clientes com formato de query em objeto (text/values) e preserva o encaminhamento", async () => {
    const { instrumented, queries, contextTxEvents } = await instrumentFakePool();

    await instrumented.query({ text: "begin" });
    await instrumented.query({ text: "select $1::text", values: ["ok"] });
    await instrumented.query({ text: "commit" });

    const events = contextTxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ round_trips: 3, outcome: "commit" });
    expect(queries).toHaveLength(3);
    expect(queries[0][0]).toEqual({ text: "begin" });
    expect(queries[1][0]).toEqual({ text: "select $1::text", values: ["ok"] });
  });

  it("ignora pools sem connect e não reinstrumenta o mesmo cliente", async () => {
    expect(() => instrumentPoolRoundTrips({})).not.toThrow();
    expect(() => instrumentPoolRoundTrips(null)).not.toThrow();

    const connectSpy = vi.fn(async () => ({ query: async () => ({ rows: [] }) }));
    const pool = { connect: connectSpy };
    instrumentPoolRoundTrips(pool);
    instrumentPoolRoundTrips(pool);
    const instrumented = (await (
      pool.connect as () => Promise<FakeQueryClient>
    )()) as FakeQueryClient;
    await instrumented.query("begin");
    await instrumented.query("commit");
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("§19.3: span e métrica por query", () => {
  it("registra app.db.query.duration por operação (sem texto) e pula begin/commit/rollback", async () => {
    const metrics = collectRecordedMetrics();
    const { instrumented } = await instrumentFakePool();

    await instrumented.query("begin");
    await instrumented.query({
      text: "select * from users where email = 'joao@example.com'",
      values: ["joao@example.com"],
    });
    await instrumented.query("commit");

    const records = metrics.queryRecords();
    expect(records).toHaveLength(1);
    expect(records[0].value).toBeGreaterThanOrEqual(0);
    expect(records[0].attributes).toEqual({
      "db.operation.name": "SELECT",
      "db.system.name": "postgresql",
    });
    expect(JSON.stringify(records[0].attributes)).not.toContain("joao@example.com");
  });

  it("propaga erro de query, finaliza a transação e mantém o wrapper íntegro", async () => {
    const { instrumented, contextTxEvents } = await instrumentFakePool({ failOn: "boom" });

    await instrumented.query("begin");
    await expect(instrumented.query("select boom")).rejects.toThrow("syntax error");
    await instrumented.query("rollback");

    expect(contextTxEvents()).toHaveLength(1);
    expect(contextTxEvents()[0]).toMatchObject({ outcome: "rollback" });
  });
});

describe("§16.7: pool saturation", () => {
  it("expõe snapshot used/idle/waiting/max e transações em voo do pool fake", async () => {
    const { instrumented, handle } = await instrumentFakePool({
      driver: "node-postgres",
      totalCount: 4,
      idleCount: 2,
      waitingCount: 1,
      max: 10,
    });
    expect(handle).toBeDefined();

    expect(handle!.read()).toEqual({
      driver: "node-postgres",
      used: 2,
      idle: 2,
      waiting: 1,
      max: 10,
      inFlightTransactions: 0,
    });

    await instrumented.query("begin");
    expect(handle!.read().inFlightTransactions).toBe(1);
    await instrumented.query("select 1");
    await instrumented.query("commit");
    expect(handle!.read().inFlightTransactions).toBe(0);
  });

  it("mede o wait time real do checkout com label driver", async () => {
    const metrics = collectRecordedMetrics();
    const { instrumented } = await instrumentFakePool({ driver: "neon-serverless" });

    await instrumented.query("select 1");

    const waits = metrics.waitRecords();
    expect(waits).toHaveLength(1);
    expect(waits[0].value).toBeGreaterThanOrEqual(0);
    expect(waits[0].attributes).toEqual({ driver: "neon-serverless" });
  });

  it("não reinstrumenta o mesmo pool (um único connect/handle)", async () => {
    const connectSpy = vi.fn(async () => ({ query: async () => ({ rows: [] }) }));
    const pool = {
      connect: connectSpy,
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      options: { max: 5 },
    };
    const first = instrumentPoolRoundTrips(pool, "node-postgres");
    const second = instrumentPoolRoundTrips(pool, "node-postgres");
    if (first) unregisters.push(first.unregister);
    expect(second).toBe(first);
    await (pool.connect as () => Promise<FakeQueryClient>)();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("§16.7: observables defensivos", () => {
  it("agrega snapshots por driver (soma used/idle/waiting/max/in-flight)", () => {
    const snapshots: DatabasePoolSnapshot[] = [
      { driver: "node-postgres", used: 1, idle: 2, waiting: 0, max: 10, inFlightTransactions: 1 },
      { driver: "node-postgres", used: 3, idle: 1, waiting: 2, max: 20, inFlightTransactions: 2 },
      {
        driver: "neon-serverless",
        used: 0,
        idle: 5,
        waiting: 0,
        max: 5,
        inFlightTransactions: 0,
      },
    ];
    expect(aggregatePoolSnapshots(snapshots)).toEqual([
      { driver: "node-postgres", used: 4, idle: 3, waiting: 2, max: 30, inFlightTransactions: 3 },
      { driver: "neon-serverless", used: 0, idle: 5, waiting: 0, max: 5, inFlightTransactions: 0 },
    ]);
  });

  it("emite used/idle/waiting/max e in-flight com label driver", () => {
    const unregister = registerPoolSnapshotSource(() => ({
      driver: "test-driver",
      used: 3,
      idle: 1,
      waiting: 2,
      max: 10,
      inFlightTransactions: 4,
    }));
    try {
      const connections = recordingObservable();
      reportPoolConnectionObservations(connections.result);
      const own = connections.observations.filter(
        (observation) => observation.attributes?.driver === "test-driver",
      );
      expect(own).toEqual([
        { value: 3, attributes: { driver: "test-driver", state: "used" } },
        { value: 1, attributes: { driver: "test-driver", state: "idle" } },
        { value: 2, attributes: { driver: "test-driver", state: "waiting" } },
        { value: 10, attributes: { driver: "test-driver", state: "max" } },
      ]);

      const inFlight = recordingObservable();
      reportPoolInFlightObservations(inFlight.result);
      expect(
        inFlight.observations.filter(
          (observation) => observation.attributes?.driver === "test-driver",
        ),
      ).toEqual([{ value: 4, attributes: { driver: "test-driver" } }]);
    } finally {
      unregister();
    }
  });

  it("não lança quando a fonte ou o exporter lançam", () => {
    const throwingSource = registerPoolSnapshotSource(() => {
      throw new Error("pool destroyed");
    });
    try {
      expect(() =>
        reportPoolConnectionObservations({
          observe: () => {
            throw new Error("exporter down");
          },
        } as unknown as ObservableResult),
      ).not.toThrow();
      expect(() =>
        reportPoolInFlightObservations({
          observe: () => {
            throw new Error("exporter down");
          },
        } as unknown as ObservableResult),
      ).not.toThrow();
    } finally {
      throwingSource();
    }
  });
});

describe("B2A-1: cobertura do caminho pool.query", () => {
  it("emite exatamente um span e uma métrica por query disparada pelo pool", async () => {
    const metrics = collectRecordedMetrics();
    const queries: unknown[][] = [];
    const pool = createPgPoolLike(recordingClient(queries));
    const handle = instrumentPoolRoundTrips(pool, "node-postgres");
    if (handle) unregisters.push(handle.unregister);

    await pool.query("select 1");
    await pool.query("select 2");

    expect(queries).toHaveLength(2);
    expect(querySpans().map((span) => span.name)).toEqual(["SELECT", "SELECT"]);
    expect(metrics.queryRecords()).toHaveLength(2);
  });

  it("cobre a forma callback de pool.query com o texto redigido", async () => {
    const queries: unknown[][] = [];
    const pool = createPgPoolLike(recordingClient(queries));
    instrumentPoolRoundTrips(pool, "node-postgres");

    const received: unknown[] = [];
    await new Promise<void>((resolve) => {
      pool.query(
        "select $1::text from users where email = 'joao@example.com'",
        ["ok"],
        (error: unknown, result: unknown) => {
          received.push(error, result);
          resolve();
        },
      );
    });

    expect(received).toEqual([undefined, { rows: [] }]);
    const spans = querySpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["db.query.text"]).toBe("select $1::text from users where email = ?");
  });

  it("não duplica o span quando o mesmo cliente atende os dois caminhos", async () => {
    const queries: unknown[][] = [];
    const pool = createPgPoolLike(recordingClient(queries));
    instrumentPoolRoundTrips(pool, "node-postgres");

    const pooledClient = (await pool.connect()) as FakeQueryClient;
    await pooledClient.query("select 1");
    expect(querySpans()).toHaveLength(1);

    await pool.query("select 2");
    expect(querySpans()).toHaveLength(2);
  });
});

describe("B2A-4: atributos do span de query", () => {
  it("grava db.system.name/db.operation.name e trunca db.query.text redigido em 256", async () => {
    const { instrumented } = await instrumentFakePool();

    const filler = Array.from({ length: 60 }, (_, index) => `colum${index}`).join(", ");
    await instrumented.query(`select 'joao@example.com', ${filler} from users`);

    const spans = querySpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("SELECT");
    expect(Object.keys(spans[0].attributes).sort()).toEqual([
      "db.operation.name",
      "db.query.text",
      "db.system.name",
    ]);
    expect(spans[0].attributes["db.system.name"]).toBe("postgresql");
    expect(spans[0].attributes["db.operation.name"]).toBe("SELECT");
    const text = String(spans[0].attributes["db.query.text"]);
    expect(text.startsWith("select ?, colum0, colum1, ")).toBe(true);
    expect(text).not.toContain("joao@example.com");
    expect(text.length).toBe(SQL_REDACTION_MAX_LENGTH);
    expect(text.endsWith("...")).toBe(true);
  });

  it("nunca anexa `values` ao span", async () => {
    const { instrumented } = await instrumentFakePool();

    await instrumented.query({
      text: "select * from users where email = $1",
      values: ["joao@example.com"],
    });

    const spans = querySpans();
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans[0].attributes)).not.toContain("joao@example.com");
    expect(spans[0].attributes["db.query.text"]).toBe("select * from users where email = $1");
  });
});

describe("B2A-4: caminho callback de client.query", () => {
  it("client.query(sql, cb) fecha um único span OK e chama o callback do usuário", async () => {
    const { instrumented } = await instrumentFakePool();

    const received: unknown[] = [];
    await new Promise<void>((resolve) => {
      instrumented.query("insert into t (a) values ('x')", (error: unknown, result: unknown) => {
        received.push(error, result);
        resolve();
      });
    });

    expect(received).toEqual([undefined, { rows: [] }]);
    const spans = querySpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("INSERT");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    expect(spans[0].attributes["db.query.text"]).toBe("insert into t (a) values (?)");
  });

  it("cb(err) vira span ERROR sem duplicar a finalização", async () => {
    const { instrumented } = await instrumentFakePool({ failOn: "boom" });

    const received: unknown[] = [];
    await new Promise<void>((resolve) => {
      instrumented.query("select boom", (error: unknown) => {
        received.push(error);
        resolve();
      });
    });

    expect((received[0] as Error).message).toBe("syntax error");
    const spans = querySpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("B2A-3: métrica nunca derruba a query", () => {
  function throwOnRecord() {
    vi.spyOn(applicationMetrics.dbQueryDuration, "record").mockImplementation(() => {
      throw new Error("metric boom");
    });
  }

  it("um record que lança não rejeita uma query que já teve sucesso", async () => {
    const { instrumented } = await instrumentFakePool();
    throwOnRecord();

    await expect(instrumented.query("select 1")).resolves.toEqual({ rows: [] });
    expect(querySpans()).toHaveLength(1);
  });

  it("um record que lança não pula o callback do usuário", async () => {
    const { instrumented } = await instrumentFakePool();
    throwOnRecord();

    // O `pg.Client` com callback entrega o resultado pelo callback; este fake o
    // invoca de forma síncrona, então um throw da instrumentação escaparia aqui.
    const received: unknown[] = [];
    let thrown: unknown;
    try {
      instrumented.query("select 1", (error: unknown, result: unknown) => {
        received.push(error, result);
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(received).toEqual([undefined, { rows: [] }]);
    expect(querySpans()).toHaveLength(1);
  });
});

describe("B2A-5: métricas de transação e de checkout nunca quebram o caminho", () => {
  const IDENTITY = { userId: "user-1", tenantId: "tenant-1", roles: ["owner"] };

  /** Um `record` que lança não pode rejeitar transação já commitada nem trocar
   * o erro real (inclusive `TenantMembershipDeniedError`). */
  function throwOnRecord(histogram: { record: (value: number) => void }, message: string) {
    vi.spyOn(histogram, "record").mockImplementation(() => {
      throw new Error(message);
    });
  }

  function recordCalls(histogram: { record: (value: number) => void }) {
    const records: Array<{ value: number; attributes: Record<string, unknown> }> = [];
    vi.spyOn(histogram, "record").mockImplementation(
      (value: number, attributes?: Record<string, unknown>) => {
        records.push({ value, attributes: attributes ?? {} });
      },
    );
    return records;
  }

  /** Mímica mínima do `db.transaction` do drizzle: só o `execute` que aplica os
   * GUCs, sem PostgreSQL. */
  function createTransactionDatabase() {
    const statements: unknown[] = [];
    const database = {
      transaction: async <T>(
        callback: (transaction: {
          execute: (fragment: unknown) => Promise<{ rows: unknown[] }>;
        }) => Promise<T>,
      ): Promise<T> =>
        callback({
          execute: async (fragment: unknown) => {
            statements.push(fragment);
            return { rows: [] };
          },
        }),
    };
    return { database: database as unknown as Database, statements };
  }

  /** Mímica do `pg.Pool` com contabilidade de aquisição/liberação: o `connect`
   * entrega o cliente de forma assíncrona, como o `pg-pool` faz, e o callback
   * roda fora de qualquer try/catch do pool — um throw ali vira
   * `uncaughtException` com o cliente preso fora do pool. Aqui o escape é
   * registrado para a falha virar asserção em vez de derrubar a suíte. */
  function createAccountingPool(client: FakeQueryClient) {
    const escapes: unknown[] = [];
    const state = { total: 1, idle: 1 };
    const pool = {
      get totalCount() {
        return state.total;
      },
      get idleCount() {
        return state.idle;
      },
      waitingCount: 0,
      options: { max: 1 },
      connect(cb?: (error: unknown, pooledClient: unknown, release: () => void) => void) {
        if (!cb) return Promise.resolve(client);
        setTimeout(() => {
          state.idle = 0;
          try {
            cb(undefined, client, () => {
              state.idle += 1;
            });
          } catch (error) {
            escapes.push(error);
          }
        }, 0);
        return undefined;
      },
      query(
        text: unknown,
        valuesOrCallback?: unknown,
        maybeCallback?: unknown,
      ): Promise<unknown> | undefined {
        const callback =
          typeof valuesOrCallback === "function"
            ? (valuesOrCallback as (error: unknown, result: unknown) => void)
            : (maybeCallback as ((error: unknown, result: unknown) => void) | undefined);
        const values = typeof valuesOrCallback === "function" ? undefined : valuesOrCallback;
        if (callback) {
          this.connect((error: unknown, pooledClient: unknown, release: () => void) => {
            if (error) return callback(error, undefined);
            (pooledClient as FakeQueryClient).query(
              text,
              values,
              (queryError: unknown, result: unknown) => {
                release();
                callback(queryError, result);
              },
            );
          });
          return undefined;
        }
        return new Promise<unknown>((resolve, reject) => {
          this.connect((error: unknown, pooledClient: unknown, release: () => void) => {
            if (error) return reject(error);
            (pooledClient as FakeQueryClient).query(
              text,
              values,
              (queryError: unknown, result: unknown) => {
                release();
                return queryError ? reject(queryError) : resolve(result);
              },
            );
          });
        });
      },
    };
    return { pool, escapes };
  }

  it("(a) um dbDuration.record que lança não rejeita uma transação que já teve sucesso", async () => {
    const { database, statements } = createTransactionDatabase();
    setDatabaseForTests(database);
    throwOnRecord(applicationMetrics.dbDuration, "dbDuration boom");

    await expect(withTenantTransaction(IDENTITY, async () => "ok")).resolves.toBe("ok");
    expect(statements).toHaveLength(1);
  });

  it("(b) um dbDuration.record que lança não substitui o erro real da operação", async () => {
    const { database } = createTransactionDatabase();
    setDatabaseForTests(database);
    throwOnRecord(applicationMetrics.dbDuration, "dbDuration boom");

    await expect(
      withTenantTransaction(IDENTITY, async () => {
        throw new Error("db exploded");
      }),
    ).rejects.toThrow("db exploded");
  });

  it("(c) um dbDuration.record que lança não engole TenantMembershipDeniedError", async () => {
    const { database } = createTransactionDatabase();
    setDatabaseForTests(database);
    throwOnRecord(applicationMetrics.dbDuration, "dbDuration boom");

    await expect(
      withResolvedTenantTransaction(
        "user-1",
        async () => undefined,
        async () => "ok",
      ),
    ).rejects.toBeInstanceOf(TenantMembershipDeniedError);
  });

  it("(d) um dbPoolWaitTime.record que lança não pendura pool.query nem esgota o pool", async () => {
    throwOnRecord(applicationMetrics.dbPoolWaitTime, "pool wait boom");
    const queries: unknown[][] = [];
    const { pool, escapes } = createAccountingPool(recordingClient(queries));
    const handle = instrumentPoolRoundTrips(pool, "node-postgres");
    if (handle) unregisters.push(handle.unregister);
    const pending = pool.query("select 1");
    if (!pending) throw new Error("pool.query sem callback precisa devolver uma promise");

    const settled = await Promise.race([
      pending.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
    ]);

    expect(settled).toBe("settled");
    expect(escapes).toEqual([]);
    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({ total: 1, idle: 1 });
    expect(queries).toHaveLength(1);
  });

  it("registra app.db.duration com o mesmo valor/atributos quando o record é sadio", async () => {
    const { database } = createTransactionDatabase();
    setDatabaseForTests(database);
    const records = recordCalls(applicationMetrics.dbDuration);

    await withTenantTransaction(IDENTITY, async () => "ok");

    expect(records).toHaveLength(1);
    expect(records[0].value).toBeGreaterThanOrEqual(0);
    expect(records[0].attributes).toEqual({});
  });
});
