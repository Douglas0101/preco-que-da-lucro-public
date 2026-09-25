import {
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type ObservableResult,
  type Span,
} from "@opentelemetry/api";
import { logJson } from "@/lib/structured-logger";

const tracer = trace.getTracer("preco-que-da-lucro", "1.0.0");
const meter = metrics.getMeter("preco-que-da-lucro", "1.0.0");

export interface DatabasePoolSnapshot {
  driver: string;
  used: number;
  idle: number;
  waiting: number;
  max: number;
  inFlightTransactions: number;
}

type PoolSnapshotSource = () => DatabasePoolSnapshot;

const poolSnapshotSources = new Set<PoolSnapshotSource>();

/** Registra uma fonte de snapshot do pool (por driver). Devolve o unregister
 * para testes; em produção os pools vivem por todo o processo. */
export function registerPoolSnapshotSource(source: PoolSnapshotSource): () => void {
  poolSnapshotSources.add(source);
  return () => {
    poolSnapshotSources.delete(source);
  };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Coleta defensiva: uma fonte que lança nunca derruba request nem exporter. */
export function collectPoolSnapshots(): DatabasePoolSnapshot[] {
  const collected: DatabasePoolSnapshot[] = [];
  for (const source of poolSnapshotSources) {
    try {
      const snapshot = source();
      if (!snapshot || typeof snapshot.driver !== "string") continue;
      collected.push({
        driver: snapshot.driver,
        used: safeCount(snapshot.used),
        idle: safeCount(snapshot.idle),
        waiting: safeCount(snapshot.waiting),
        max: safeCount(snapshot.max),
        inFlightTransactions: safeCount(snapshot.inFlightTransactions),
      });
    } catch {
      // Observabilidade nunca pode quebrar o caminho da request.
    }
  }
  return collected;
}

/** Agrega por driver para nunca duplicar série quando há mais de um pool. */
export function aggregatePoolSnapshots(
  snapshots: readonly DatabasePoolSnapshot[],
): DatabasePoolSnapshot[] {
  const byDriver = new Map<string, DatabasePoolSnapshot>();
  for (const snapshot of snapshots) {
    const aggregated = byDriver.get(snapshot.driver) ?? {
      driver: snapshot.driver,
      used: 0,
      idle: 0,
      waiting: 0,
      max: 0,
      inFlightTransactions: 0,
    };
    aggregated.used += safeCount(snapshot.used);
    aggregated.idle += safeCount(snapshot.idle);
    aggregated.waiting += safeCount(snapshot.waiting);
    aggregated.max += safeCount(snapshot.max);
    aggregated.inFlightTransactions += safeCount(snapshot.inFlightTransactions);
    byDriver.set(snapshot.driver, aggregated);
  }
  return [...byDriver.values()];
}

export const applicationMetrics = {
  requestDuration: meter.createHistogram("app.request.duration", { unit: "ms" }),
  dbDuration: meter.createHistogram("app.db.duration", { unit: "ms" }),
  dbQueryDuration: meter.createHistogram("app.db.query.duration", { unit: "ms" }),
  dbPoolWaitTime: meter.createHistogram("app.db.pool.wait_time", { unit: "ms" }),
  dbPoolConnections: meter.createObservableGauge("app.db.pool.connections", {
    unit: "{connection}",
  }),
  dbPoolInFlightTransactions: meter.createObservableGauge("app.db.pool.in_flight_transactions", {
    unit: "{transaction}",
  }),
  aiDuration: meter.createHistogram("app.ai.duration", { unit: "ms" }),
  // §29: fases da latência percebida no chat não-streaming. `app.ai.duration`
  // continua medindo cada tentativa de gateway; estes histogramas medem o
  // tempo desde o aceite da mensagem até acknowledge/conteúdo/final.
  aiTimeToAcknowledge: meter.createHistogram("app.ai.time_to_acknowledge", { unit: "ms" }),
  aiTimeToFirstContent: meter.createHistogram("app.ai.time_to_first_content", { unit: "ms" }),
  aiTimeToFinal: meter.createHistogram("app.ai.time_to_final", { unit: "ms" }),
  toolDuration: meter.createHistogram("app.ai.tool.duration", { unit: "ms" }),
  errors: meter.createCounter("app.errors"),
  aiTimeouts: meter.createCounter("app.ai.timeouts"),
  aiQuotas: meter.createCounter("app.ai.quotas"),
  aiEstimatedCostTotal: meter.createCounter("app.ai.estimated_cost_total"),
  aiCostUnknownTotal: meter.createCounter("app.ai.cost_unknown_total"),
  aiUsageUnknownTotal: meter.createCounter("app.ai.usage_unknown_total"),
  // TRILHO B: o job de reconciliação trata eventos `usage_unknown` que o varredor
  // de reservas nunca alcança (predicados disjuntos). `total` conta as linhas
  // tratadas; `failed` conta as que terminaram sem medição. Hoje as duas
  // coincidem, porque o gateway não expõe retrieval por id e nenhum payload de
  // uso é persistido — continuarão distintas se um caminho de medição existir.
  aiReconciliationTotal: meter.createCounter("app.ai.reconciliation_total"),
  aiReconciliationFailed: meter.createCounter("app.ai.reconciliation_failed"),
  aiReconciliationOldestAge: meter.createObservableGauge("app.ai.reconciliation_oldest_age_ms", {
    unit: "ms",
  }),
  toolExecutions: meter.createCounter("app.ai.tool.executions"),
  conversationStateTransitions: meter.createCounter("app.ai.conversation_state_transitions"),
  conversationInvalidTransitions: meter.createCounter("app.ai.conversation_invalid_transitions"),
  financialStates: meter.createCounter("app.financial.states"),
  financialEngineVersion: meter.createCounter("app.financial.engine_version"),
  salesCreatedTotal: meter.createCounter("app.sales.created_total"),
  salesSummaryDuration: meter.createHistogram("app.sales.summary_duration", { unit: "ms" }),
  diagnosticCalculationTotal: meter.createCounter("app.diagnostic.calculation_total"),
  simulationSavedTotal: meter.createCounter("app.simulation.saved_total"),
  snapshotCreatedTotal: meter.createCounter("app.snapshot.created_total"),
  snapshotFailureTotal: meter.createCounter("app.snapshot.failure_total"),
};

/** Observa used/idle/waiting/max por driver — `state` evita 4 métricas novas. */
export function reportPoolConnectionObservations(result: ObservableResult): void {
  try {
    for (const snapshot of aggregatePoolSnapshots(collectPoolSnapshots())) {
      result.observe(snapshot.used, { driver: snapshot.driver, state: "used" });
      result.observe(snapshot.idle, { driver: snapshot.driver, state: "idle" });
      result.observe(snapshot.waiting, { driver: snapshot.driver, state: "waiting" });
      result.observe(snapshot.max, { driver: snapshot.driver, state: "max" });
    }
  } catch {
    // Callbacks de observable nunca podem lançar.
  }
}

export function reportPoolInFlightObservations(result: ObservableResult): void {
  try {
    for (const snapshot of aggregatePoolSnapshots(collectPoolSnapshots())) {
      result.observe(snapshot.inFlightTransactions, { driver: snapshot.driver });
    }
  } catch {
    // Callbacks de observable nunca podem lançar.
  }
}

applicationMetrics.dbPoolConnections.addCallback((result) => {
  reportPoolConnectionObservations(result);
});

applicationMetrics.dbPoolInFlightTransactions.addCallback((result) => {
  reportPoolInFlightObservations(result);
});

/** Idade do evento `usage_unknown` mais antigo visto na varredura mais recente
 * da reconciliação. `null` significa **nunca medido** — nenhuma varredura
 * completou, então o gauge não emite ponto nenhum. Uma varredura que completou
 * e não achou candidato reporta `0`: ela *observou* que não há atraso pendente,
 * e manter o valor anterior de pé publicaria para sempre a idade de um backlog
 * já tratado (defeito D2 do adversarial). */
let reconciliationOldestAgeMs: number | null = null;

export function reportReconciliationOldestAge(ageMs: number | null): void {
  reconciliationOldestAgeMs =
    typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : null;
}

applicationMetrics.aiReconciliationOldestAge.addCallback((result) => {
  if (reconciliationOldestAgeMs !== null) result.observe(reconciliationOldestAgeMs);
});

/** Abre um span de query sem tornar o contexto ativo (o wrapper de client
 * preserva callback/thenable e finaliza o span manualmente). */
export function startDatabaseQuerySpan(operation: string, redactedQueryText?: string): Span {
  const attributes: Attributes = {
    "db.system.name": "postgresql",
    "db.operation.name": operation,
  };
  if (redactedQueryText !== undefined) attributes["db.query.text"] = redactedQueryText;
  return tracer.startSpan(operation, { attributes });
}

export function endSpanWithResult(span: Span, error?: unknown): void {
  if (error !== undefined && error !== null) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (error instanceof Error) span.recordException(error);
    else span.recordException(String(error));
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

let telemetryStarted = false;
let telemetryStarting: Promise<void> | undefined;
let activeSdk: { shutdown(): Promise<void> } | undefined;
let shutdownPromise: Promise<void> | undefined;

/** Encerra o SDK ativo com single-flight.
 *
 * Os handlers de sinal e `flushTelemetry` compartilham a MESMA promise. Sem isto
 * um segundo chamador recebe o retorno antecipado de `sdk.shutdown()` — que é
 * no-op depois do primeiro (o SDK apenas emite `diag.warn`) — e resolve ANTES do
 * dreno em andamento terminar: a garantia "drenou antes de sair" deixaria de
 * valer justamente quando um sinal vence a corrida. */
function shutdownActiveSdk(): Promise<void> {
  const sdk = activeSdk;
  if (!sdk) return Promise.resolve();
  activeSdk = undefined;
  shutdownPromise ??= sdk
    .shutdown()
    .catch((error: unknown) => logJson("warn", "telemetry.shutdown_failed", { error }));
  return shutdownPromise;
}

/** OTLP is opt-in and initialization failures never block or fail a request. */
export function ensureTelemetryStarted(): void {
  if (telemetryStarted || telemetryStarting || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  telemetryStarting = (async () => {
    try {
      // These packages are server-only. Variable, vite-ignored imports prevent a
      // server function's shared module graph from pulling Node SDK internals
      // into the browser bundle while keeping OTLP available at runtime.
      const sdkPackage = "@opentelemetry/sdk-node";
      const exporterPackage = "@opentelemetry/exporter-trace-otlp-http";
      const metricExporterPackage = "@opentelemetry/exporter-metrics-otlp-http";
      const metricsSdkPackage = "@opentelemetry/sdk-metrics";
      const [
        { NodeSDK },
        { OTLPTraceExporter },
        { OTLPMetricExporter },
        { PeriodicExportingMetricReader },
      ] = await Promise.all([
        import(/* @vite-ignore */ sdkPackage) as Promise<typeof import("@opentelemetry/sdk-node")>,
        import(/* @vite-ignore */ exporterPackage) as Promise<
          typeof import("@opentelemetry/exporter-trace-otlp-http")
        >,
        import(/* @vite-ignore */ metricExporterPackage) as Promise<
          typeof import("@opentelemetry/exporter-metrics-otlp-http")
        >,
        import(/* @vite-ignore */ metricsSdkPackage) as Promise<
          typeof import("@opentelemetry/sdk-metrics")
        >,
      ]);
      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, "");
      const exportIntervalMillis = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS ?? 15_000);
      const sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME ?? "preco-que-da-lucro",
        traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
        metricReader: new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
          exportIntervalMillis:
            Number.isFinite(exportIntervalMillis) && exportIntervalMillis >= 1_000
              ? exportIntervalMillis
              : 15_000,
        }),
      });
      sdk.start();
      telemetryStarted = true;
      activeSdk = sdk;
      const shutdown = () => {
        void shutdownActiveSdk();
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    } catch (error) {
      logJson("warn", "telemetry.initialization_failed", { error });
    } finally {
      telemetryStarting = undefined;
    }
  })();
}

/** Variante aguardável de `ensureTelemetryStarted`, para processos curtos
 * (scripts e jobs) que precisam do provider global registrado e não podem
 * terminar antes do primeiro ciclo do exportador periódico.
 *
 * LIMITE MEDIDO — não leia isto como "as métricas passam a sair do processo":
 * o `meter` e os instrumentos de `applicationMetrics` nascem no MOMENTO DO
 * IMPORT deste módulo, quando a API ainda devolve os singletons noop (`NOOP_METER`
 * é compartilhado, `NOOP_COUNTER_METRIC.add` é vazio e `addCallback` nunca
 * registra). Registrar o provider aqui, depois, NÃO re-vincula instrumentos já
 * criados: `@opentelemetry/api` não tem proxy de métrica — o único proxy é o de
 * trace. Um processo que importa este módulo e só então chama `startTelemetry()`
 * continua emitindo em instrumentos noop, e o `PeriodicExportingMetricReader`
 * nem invoca o exporter. Fechado apenas por `F-otel-provider-order`, WP próprio
 * que torna a obtenção do meter lazy. */
export async function startTelemetry(): Promise<void> {
  ensureTelemetryStarted();
  await telemetryStarting;
}

/** Drena o exportador periódico e encerra o SDK.
 *
 * Um processo curto que esquece isto perde a última janela de métricas: com o
 * `exportIntervalMillis` padrão de 15 s, o processo termina antes do primeiro
 * flush. Idempotente — um segundo chamado não encontra SDK ativo e devolve sem
 * erro. Compartilha a promise de `shutdownActiveSdk` com os handlers de sinal,
 * então aguarda o MESMO dreno em vez de receber um retorno antecipado. Não
 * rearma `telemetryStarted`: depois do `shutdown` o SDK não volta. */
export async function flushTelemetry(): Promise<void> {
  await telemetryStarting;
  await shutdownActiveSdk();
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
