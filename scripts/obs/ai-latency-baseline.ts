/**
 * §29 — baseline CONTROLADO (mock) das fases de latência do chat não-streaming.
 *
 * Executa `executeSendChatMessage` com banco em memória (`setDatabaseForTests`)
 * e gateway mock, no relógio real do processo, e grava o raw das três fases
 * (`app.ai.time_to_acknowledge`, `app.ai.time_to_first_content`,
 * `app.ai.time_to_final`) em `docs/evidence/slo-ai-<data>/`.
 *
 * Regime `CONTROLLED`: provider mockado com atraso simulado, sem HTTP nem
 * PostgreSQL reais — os números medem a orquestração, não a produção. O
 * baseline provider-real é declarado `OBSERVED-UNAVAILABLE` (H-6 pendente) e
 * nunca recebe rótulo CONTROLADO; a disciplina é validada por
 * `scripts/obs/baseline-regime.ts` antes de gravar (fail-closed).
 *
 * Uso: npx tsx scripts/obs/ai-latency-baseline.ts [--runs=50] [--delay-ms=40] [--date=YYYY-MM-DD] [--out=<dir>]
 */

// PRIMEIRO import: sem MeterProvider os instrumentos noop do @opentelemetry/api
// são um único objeto compartilhado, e o raw de cada fase sairia contaminado
// pelas demais séries (mesmo `record` para todos os histogramas).
import "@/test/helpers/otel-metrics";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import type { Histogram } from "@opentelemetry/api";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { executeSendChatMessage, type ModelCaller } from "@/lib/chat-execution.server";
import {
  contentResponse,
  createFakeBudgetLedger,
  createFakeConversationService,
  installFakeDatabase,
  instantToolRunner,
  restoreFakeDatabase,
  TEST_IDENTITY,
  toolCallResponse,
} from "@/test/helpers/chat-execution-fakes";
import { percentile } from "../perf/summarize.mjs";
import { assertBaselineDiscipline, UNAVAILABLE_REGIME } from "./baseline-regime";

/** Séries publicadas por `src/instrumentation/telemetry.ts`. */
const PHASES = [
  { key: "acknowledge", metric: "app.ai.time_to_acknowledge" },
  { key: "firstContent", metric: "app.ai.time_to_first_content" },
  { key: "final", metric: "app.ai.time_to_final" },
] as const;

type PhaseKey = (typeof PHASES)[number]["key"];

type PhaseSamples = Record<PhaseKey, number[]>;

const INSTRUMENTS: Record<PhaseKey, Histogram> = {
  acknowledge: applicationMetrics.aiTimeToAcknowledge,
  firstContent: applicationMetrics.aiTimeToFirstContent,
  final: applicationMetrics.aiTimeToFinal,
};

interface Scenario {
  id: string;
  description: string;
  providerDelayMs: number;
  toolRounds: number;
}

interface Args {
  runs: number;
  delayMs: number;
  date: string;
  outDir: string;
}

export function parseArgs(argv: readonly string[]): Args {
  let runs = 50;
  let delayMs = 40;
  let date = new Date().toISOString().slice(0, 10);
  let outDir: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--runs=")) {
      runs = Number(arg.slice("--runs=".length));
      if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs deve ser inteiro >= 1");
    } else if (arg.startsWith("--delay-ms=")) {
      delayMs = Number(arg.slice("--delay-ms=".length));
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms deve ser >= 0");
    } else if (arg.startsWith("--date=")) {
      const value = arg.slice("--date=".length).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--date deve ser YYYY-MM-DD");
      date = value;
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length).trim();
    } else {
      throw new Error(`argumento desconhecido: ${arg}`);
    }
  }
  return { runs, delayMs, date, outDir: outDir ?? `docs/evidence/slo-ai-${date}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Espelha os valores que o código de produção registra: o raw é lido dos
 * próprios instrumentos, então uma fase não registrada aparece como amostra
 * faltante em vez de virar silêncio (`main` falha se n !== execuções).
 */
function capturePhaseSamples(samples: PhaseSamples): () => void {
  const restores = PHASES.map(({ key }) => {
    const instrument = INSTRUMENTS[key];
    const original = instrument.record.bind(instrument);
    instrument.record = (value: number) => {
      samples[key].push(value);
      original(value);
    };
    return () => {
      instrument.record = original;
    };
  });
  return () => {
    for (const restore of restores) restore();
  };
}

function mockModelCaller(scenario: Scenario): ModelCaller {
  let call = 0;
  return async () => {
    call += 1;
    await sleep(scenario.providerDelayMs);
    return call <= scenario.toolRounds ? toolCallResponse() : contentResponse("Pronto!");
  };
}

async function measureScenario(scenario: Scenario, runs: number): Promise<PhaseSamples> {
  const totals: PhaseSamples = { acknowledge: [], firstContent: [], final: [] };
  for (let run = 0; run < runs; run += 1) {
    const runSamples: PhaseSamples = { acknowledge: [], firstContent: [], final: [] };
    const stopCapture = capturePhaseSamples(runSamples);
    try {
      await executeSendChatMessage({ message: "Qual o preço do bolo?" }, TEST_IDENTITY, {
        modelCaller: mockModelCaller(scenario),
        budgetLedger: createFakeBudgetLedger(),
        conversationService: createFakeConversationService(),
        toolRunner: instantToolRunner,
      });
    } finally {
      stopCapture();
    }
    for (const { key } of PHASES) totals[key].push(...runSamples[key]);
  }
  return totals;
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(3));
}

function phaseStats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? null),
    p50: round(percentile(sorted, 50) as number | null),
    p75: round(percentile(sorted, 75) as number | null),
    p95: round(percentile(sorted, 95) as number | null),
    max: round(sorted[sorted.length - 1] ?? null),
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const scenarios: Scenario[] = [
    {
      id: "mock-no-tool",
      description: "um round de gateway, resposta direta sem tool",
      providerDelayMs: args.delayMs,
      toolRounds: 0,
    },
    {
      id: "mock-tool-round",
      description: "dois rounds de gateway (1 tool call determinística)",
      providerDelayMs: args.delayMs,
      toolRounds: 1,
    },
  ];

  const startedAt = new Date().toISOString();
  installFakeDatabase();
  const measured: Array<{ scenario: Scenario; samples: PhaseSamples }> = [];
  try {
    for (const scenario of scenarios) {
      measured.push({ scenario, samples: await measureScenario(scenario, args.runs) });
    }
  } finally {
    restoreFakeDatabase();
  }
  const endedAt = new Date().toISOString();

  const series = measured.flatMap(({ scenario, samples }) =>
    PHASES.map(({ key, metric }) => ({
      name: metric,
      scenario: scenario.id,
      regime: "CONTROLLED",
      provider: "mock",
      unit: "ms",
      n: samples[key].length,
      stats: phaseStats(samples[key]),
      samples: samples[key],
    })),
  );
  const incomplete = series.filter((entry) => entry.n !== args.runs);
  if (incomplete.length > 0) {
    throw new Error(
      `fase não registrada em todas as execuções: ${incomplete
        .map((entry) => `${entry.scenario}/${entry.name} n=${entry.n}`)
        .join(", ")} (esperado ${args.runs})`,
    );
  }

  const report = {
    artifact: "§29 — fases de latência do chat (baseline CONTROLADO | mock)",
    generated_at: new Date().toISOString(),
    regime: "CONTROLLED",
    provider: "mock",
    method: {
      command: "npx tsx scripts/obs/ai-latency-baseline.ts",
      harness: "executeSendChatMessage com banco em memória e gateway mock",
      harness_source: "src/test/helpers/chat-execution-fakes.ts",
      clock: "performance.now() real do processo",
      runs_per_scenario: args.runs,
      provider_delay_ms: args.delayMs,
      excludes: [
        "transporte HTTP e TTFB do BFF",
        "latência real do provider de IA",
        "I/O de PostgreSQL real",
      ],
      node: process.version,
    },
    unavailable: PHASES.map(({ metric }) => ({
      name: metric,
      regime: UNAVAILABLE_REGIME,
      provider: "real",
      n: 0,
      reason:
        "H-6 (tráfego real autorizado) pendente: não existe amostra OBSERVED e nenhum rótulo CONTROLADO pode ser emitido para provider real.",
    })),
    scenarios: measured.map(({ scenario }) => ({
      id: scenario.id,
      description: scenario.description,
      provider_delay_ms: scenario.providerDelayMs,
      tool_rounds: scenario.toolRounds,
      runs: args.runs,
      // Soma simulada por execução: as fases acima dela são overhead orquestrado.
      simulated_provider_total_ms: scenario.providerDelayMs * (scenario.toolRounds + 1),
    })),
    window: { started_at: startedAt, ended_at: endedAt },
    series,
  };
  assertBaselineDiscipline(report);

  const outDir = resolve(args.outDir);
  await mkdir(outDir, { recursive: true });
  const file = resolve(outDir, "ai-latency-controlled.json");
  // O raw versionado passa pelo mesmo formato do gate (`prettier --check`).
  const config = (await resolveConfig(file)) ?? {};
  const formatted = await format(JSON.stringify(report), { ...config, parser: "json" });
  await writeFile(file, formatted, "utf8");
  const summary = series
    .map((entry) => `${entry.scenario}/${entry.name} p75=${String(entry.stats.p75)}ms`)
    .join(" · ");
  console.log(`Baseline CONTROLADO (mock, ${args.runs} execuções): ${summary} → ${args.outDir}`);
}

// Guarda de entrypoint: só roda main() quando este arquivo é executado direto,
// para que importá-lo em testes não dispare o sampler. A comparação usa
// `pathToFileURL` — o padrão canônico do repositório (ver m02-secrets-audit.ts) —
// porque uma URL `file://` montada à mão quebra em paths com caracteres
// significativos para URL (ex.: '#' ou '?').
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
