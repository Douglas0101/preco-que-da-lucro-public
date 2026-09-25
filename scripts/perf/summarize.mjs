#!/usr/bin/env node
/**
 * F0-04 — sumariza o raw CONTROLADO gravado por `capture-baseline.mjs` e gera
 * `report.md` com os 8 itens de §5 do Plano Mestre (p50/p95 de rotas, query
 * count por tela, query duration, dashboard, lista de produtos, AI latency,
 * bundle e Core Web Vitals em ambiente controlado).
 *
 * Uso:
 *   node scripts/perf/summarize.mjs [--dir <diretório-da-evidência>]
 *
 * O diretório padrão é `docs/evidence/perf-controlled-2026-09-13`. O raw pode
 * existir parcialmente: lacunas são declaradas no relatório, nunca maquiadas.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultEvidenceDir = path.join(root, "docs/evidence/perf-controlled-2026-09-13");

const SECTION_TITLES = [
  "1. p50/p95 de rotas internas",
  "2. Query count por tela",
  "3. Query duration",
  "4. Tempo de carregamento do dashboard",
  "5. Tempo de lista de produtos",
  "6. AI latency",
  "7. Tamanho de bundle",
  "8. Core Web Vitals em ambiente controlado",
];

/**
 * Percentil com interpolação linear entre ranks (método R-7, default do
 * numpy/Excel): rank = (p/100) * (n - 1). `null` quando não há amostras.
 */
export function percentile(values, p) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0];
  const rank = (p / 100) * (numbers.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return numbers[lower];
  return numbers[lower] + (numbers[upper] - numbers[lower]) * (rank - lower);
}

function stats(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return { n: 0, min: null, max: null, p50: null, p95: null };
  return {
    n: numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    p50: percentile(numbers, 50),
    p95: percentile(numbers, 95),
  };
}

function parsePhase(value) {
  if (typeof value !== "string" || !value.startsWith("route:")) return null;
  return value.slice("route:".length);
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Constrói a estrutura do relatório a partir do raw (objetos já parseados).
 * Entradas ausentes viram lacunas explícitas — o summarize nunca inventa
 * números.
 */
export function summarize(raw) {
  const meta = raw.meta ?? {};
  const routeSamples = raw.routeSamples ?? [];
  const chatSamples = raw.chatSamples ?? [];
  const contextTx = raw.contextTx ?? [];
  const aiAttempts = raw.aiAttempts ?? [];
  const bundleReport = raw.bundleReport ?? null;

  const measuredRoutes = routeSamples.filter(
    (sample) => sample.kind === "route" && !sample.warmup && sample.status === 200,
  );
  const routes = [];
  for (const [route, samples] of groupBy(measuredRoutes, (sample) => sample.route)) {
    const serverFnDurations = samples.flatMap((sample) =>
      (sample.serverFn ?? []).map((entry) => entry.durationMs),
    );
    routes.push({
      route,
      samples: samples.length,
      ready: stats(samples.map((sample) => sample.readyMs)),
      ttfb: stats(samples.map((sample) => sample.ttfbMs)),
      fcp: stats(samples.map((sample) => sample.fcpMs)),
      lcp: stats(samples.map((sample) => sample.lcpMs)),
      cls: stats(samples.map((sample) => sample.cls)),
      load: stats(samples.map((sample) => sample.loadMs)),
      serverFn: stats(serverFnDurations),
      errors: samples.filter((sample) => sample.error).length,
    });
  }
  routes.sort((a, b) => a.route.localeCompare(b.route));

  const measuredContextTx = contextTx.filter((entry) => !entry.warmup);
  const query = [];
  for (const [route, entries] of groupBy(measuredContextTx, (entry) => parsePhase(entry.phase))) {
    query.push({
      route,
      events: entries.length,
      roundTrips: entries.reduce((total, entry) => total + (entry.round_trips ?? 0), 0),
      duration: stats(entries.map((entry) => entry.duration_ms)),
      outcomes: Object.fromEntries(
        [...groupBy(entries, (entry) => entry.outcome ?? "unknown")].map(([outcome, list]) => [
          outcome,
          list.length,
        ]),
      ),
    });
  }
  query.sort((a, b) => a.route.localeCompare(b.route));

  const measuredAi = aiAttempts.filter(
    (attempt) => !attempt.warmup && attempt.outcome === "success",
  );
  const aiLatency = stats(measuredAi.map((attempt) => attempt.durationMs));
  const aiByOutcome = Object.fromEntries(
    [
      ...groupBy(
        aiAttempts.filter((attempt) => !attempt.warmup),
        (attempt) => attempt.outcome,
      ),
    ].map(([outcome, list]) => [outcome, list.length]),
  );
  const aiByModel = [...groupBy(measuredAi, (attempt) => attempt.model ?? "unknown")].map(
    ([model, list]) => ({ model, ...stats(list.map((attempt) => attempt.durationMs)) }),
  );
  const aiBySource = Object.fromEntries(
    [
      ...groupBy(measuredAi, (attempt) => {
        const phase = String(attempt.phase ?? "");
        if (phase.startsWith("chat:")) return "chat-http";
        if (phase.startsWith("ai:direct")) return "direct-probe";
        return "other";
      }),
    ].map(([source, list]) => [source, list.length]),
  );
  const chatSend = stats(
    chatSamples
      .filter((sample) => !sample.warmup && sample.status === 200)
      .map((sample) => sample.sendMs),
  );

  const bundle = bundleReport
    ? {
        budget: bundleReport.budget ?? null,
        entries: (bundleReport.entries ?? []).map((entry) => ({
          file: entry.file,
          minifiedBytes: entry.minifiedBytes,
          gzipBytes: entry.gzipBytes,
          brotliBytes: entry.brotliBytes,
          passed: entry.passed,
          initialGraph: entry.initialGraph
            ? {
                files: entry.initialGraph.files?.length ?? null,
                minifiedBytes: entry.initialGraph.minifiedBytes,
                gzipBytes: entry.initialGraph.gzipBytes,
                brotliBytes: entry.initialGraph.brotliBytes,
                limitBytes: entry.initialGraph.limitBytes,
              }
            : null,
        })),
      }
    : null;

  const gaps = [...(meta.gaps ?? [])];
  if (routes.length === 0) gaps.push("Nenhuma amostra de rota medida (Playwright indisponível?).");
  if (query.length === 0) gaps.push("Nenhum evento app.context_tx atribuído (sem query count).");
  if (measuredAi.length === 0) gaps.push("Nenhum ai.model_attempt 'success' medido.");
  if (!bundle) gaps.push("bundle-report.json ausente.");
  if (measuredRoutes.some((sample) => !Number.isFinite(sample.lcpMs))) {
    gaps.push("LCP ausente em parte das amostras (PerformanceObserver sem entrada).");
  }

  return {
    schemaVersion: 1,
    label: meta.label ?? "CONTROLADO",
    generatedAt: new Date().toISOString(),
    sectionTitles: SECTION_TITLES,
    meta,
    routes,
    query,
    chat: { samples: chatSend.n, send: chatSend },
    ai: { latency: aiLatency, byOutcome: aiByOutcome, byModel: aiByModel, bySource: aiBySource },
    bundle,
    gaps,
  };
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function routeTable(rows, rowFor) {
  const lines = ["| Rota | n | p50 | p95 | min | max |", "| ---- | - | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(rowFor(row));
  return lines;
}

/* ------------------------------------------------------------------ §35 --- *
 * O `report.md` gerado é descoberto pelo gate `src/test/perf-evidence.test.ts`
 * (caminho `docs/evidence/perf-<tema>-<data>/`), que exige os 7 rótulos de §35.
 * Regenerar o relatório NÃO pode apagar o contrato — este bloco é emitido pelo
 * próprio gerador, com valores derivados do raw.
 *
 * Regra de honestidade: o que o raw não tem vira `N/A`/lacuna declarada — nunca
 * um número inventado. Os rótulos de JULGAMENTO (`hypothesis`, `before`,
 * `change`, `decision`) podem ser declarados verbatim pelo operador em
 * `meta.section35.<rótulo>` do raw; sem declaração, saem os padrões derivados
 * abaixo (`decision` é conservadora: sem amostra de rota — métrica primária — ou
 * com rótulo(s) de comparação declarado(s) sem decisão, sai `follow-up`;
 * `revert` nunca é derivado, só declarado). Com rótulo de comparação declarado o
 * gerador não afirma ausência de ganho nem conclui `keep`: a leitura do ganho é
 * do autor — e o texto cita apenas os rótulos realmente declarados.
 * -------------------------------------------------------------------------- */

const SECTION_35_HEADING = "## §35 — rótulos de evidência de performance";
const SECTION_35_LABELS = [
  "hypothesis",
  "metric",
  "before",
  "change",
  "after",
  "result",
  "decision",
];

/** Texto não vazio, ou `null` (nunca inventa). */
function declaredText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Rótulo declarado no raw (`meta.section35.<rótulo>`), verbatim. */
function declaredLabel(meta, label) {
  const section35 = meta.section35;
  if (!section35 || typeof section35 !== "object") return null;
  return declaredText(section35[label]);
}

/** Ambiente declarado no raw (base URL, banco, mock de IA, runtime, browser). */
function environmentSummary(meta) {
  const parts = [];
  const baseUrl = declaredText(meta.baseUrl);
  if (baseUrl) parts.push(`base \`${baseUrl}\``);
  const database = meta.database;
  if (database && typeof database === "object") {
    const name = declaredText(database.database) ?? "?";
    const host = declaredText(database.host) ?? "?";
    parts.push(
      `PostgreSQL \`${name}\` em \`${host}\` (${declaredText(database.driver) ?? "driver não declarado"})`,
    );
  } else {
    parts.push("banco não declarado no raw");
  }
  const aiMock = meta.aiMock;
  if (aiMock && typeof aiMock === "object") {
    const latency = Number.isFinite(aiMock.latencyMs) ? `${aiMock.latencyMs} ms` : "não declarada";
    parts.push(
      aiMock.enabled === true
        ? `IA mockada em processo (latência artificial ${latency})`
        : "IA não mockada (gateway real)",
    );
  } else {
    parts.push("IA não declarada no raw");
  }
  const runtime = [declaredText(meta.node), declaredText(meta.platform)].filter(Boolean);
  if (runtime.length > 0) parts.push(runtime.join(" / "));
  const playwright = meta.playwright;
  if (playwright && typeof playwright === "object") {
    const version = [declaredText(playwright.browser), declaredText(playwright.version)]
      .filter(Boolean)
      .join(" ");
    if (version !== "") parts.push(`Playwright ${version}`);
  }
  return parts.join("; ");
}

function windowLabel(meta) {
  const started = declaredText(meta.startedAt);
  const finished = declaredText(meta.finishedAt);
  if (!started && !finished) return "janela não declarada no raw";
  return `${started ?? "?"} → ${finished ?? "?"}`;
}

function sampleLabel(meta, data) {
  const iterations = Number.isFinite(meta.iterations)
    ? meta.iterations
    : (data.routes[0]?.ready.n ?? null);
  if (!Number.isFinite(iterations)) return "n não declarado no raw";
  const warmup = Number.isFinite(meta.warmupIterations) ? meta.warmupIterations : null;
  const warmupText =
    warmup === null
      ? "warmup não declarado"
      : `${warmup} ${warmup === 1 ? "descartado" : "descartados"}`;
  return `n=${iterations} amostras por rota (${warmupText})`;
}

function rangeText(values, render = formatNumber) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const min = render(Math.min(...finite));
  const max = render(Math.max(...finite));
  return min === max ? min : `${min}–${max}`;
}

function routeMetricsText(data) {
  if (data.routes.length === 0) return "nenhuma amostra de rota medida (lacuna declarada)";
  const readiness = data.routes.map(
    (row) => `\`${row.route}\` ${formatNumber(row.ready.p50)}/${formatNumber(row.ready.p95)} ms`,
  );
  return `prontidão p50/p95 — ${readiness.join("; ")}`;
}

function vitalsText(data) {
  const lcp = rangeText(data.routes.map((row) => row.lcp.p50));
  const cls = rangeText(
    data.routes.map((row) => row.cls.p50),
    (value) => formatNumber(value, 4),
  );
  const parts = [];
  if (lcp) parts.push(`LCP p50 ${lcp} ms`);
  if (cls) parts.push(`CLS p50 ${cls}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function queryText(data) {
  if (data.query.length === 0) return "sem evento `app.context_tx` atribuído (lacuna declarada)";
  const rows = data.query.map((row) => {
    const perEvent = row.events > 0 ? formatNumber(row.roundTrips / row.events, 2) : "—";
    return `\`${row.route}\` ${perEvent} RT/evento, transação p50 ${formatNumber(
      row.duration.p50,
    )} ms`;
  });
  return `query: ${rows.join("; ")}`;
}

function bundleText(data) {
  const entry = data.bundle?.entries?.[0];
  if (!data.bundle || !entry) return "`bundle-report.json` ausente (lacuna declarada)";
  const graph = entry.initialGraph;
  const graphText = graph
    ? `, grafo inicial ${bytes(graph.minifiedBytes)} ≤ ${graph.limitBytes ?? "?"} B`
    : "";
  return `bundle \`${entry.file}\` ${bytes(entry.minifiedBytes)} min / ${bytes(
    entry.gzipBytes,
  )} gzip${graphText} → ${entry.passed ? "PASS" : "FAIL"}`;
}

function aiText(data) {
  const latency = data.ai.latency;
  const latencyText =
    latency.n === 0
      ? "AI latency não medida (nenhum `ai.model_attempt` com outcome `success`)"
      : `AI latency n=${latency.n} p50 ${formatNumber(latency.p50)}/p95 ${formatNumber(
          latency.p95,
        )} ms`;
  const chatText =
    data.chat.samples === 0
      ? "chat HTTP n=0 — circuito completo não medido"
      : `chat HTTP n=${data.chat.samples} p50 ${formatNumber(
          data.chat.send.p50,
        )}/p95 ${formatNumber(data.chat.send.p95)} ms`;
  return `${latencyText}; ${chatText}`;
}

/** Métricas derivadas do raw, na ordem em que o relatório as traz. */
function measuredParts(data) {
  const ttfb = rangeText(data.routes.map((row) => row.ttfb.p50));
  const serverFn = rangeText(data.routes.map((row) => row.serverFn.p50));
  const latency = [
    ttfb ? `TTFB p50 ${ttfb} ms` : null,
    serverFn ? `server fn p50 ${serverFn} ms` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return [
    routeMetricsText(data),
    latency === "" ? null : latency,
    queryText(data),
    vitalsText(data),
    bundleText(data),
    aiText(data),
  ].filter(Boolean);
}

/** As 7 linhas de §35, todas derivadas do raw (ou declaradas em `meta.section35`). */
function section35Lines(data) {
  const { meta } = data;
  const environment = environmentSummary(meta);
  const commit = declaredText(meta.commit) ?? "não declarado no raw";
  const window = windowLabel(meta);
  const samples = sampleLabel(meta, data);

  const derived = {
    hypothesis: `a captura \`${data.label}\` (${environment}) é re-derivável do raw deste diretório — \`node scripts/perf/summarize.mjs --dir <dir>\` reproduz este bloco; commit de origem \`${commit}\`, janela \`${window}\`, ${samples}.`,
    metric:
      "prontidão de rota (dados visíveis) p50/p95 em ms — métrica primária; secundárias: TTFB ms, prontidão das server functions ms, round trips e duração por evento `app.context_tx`, LCP p50/CLS p50, latência de IA ms e bytes minificados do entry/grafo inicial.",
    before: `\`N/A\` — o raw deste diretório não embute uma captura anterior do mesmo regime (commit \`${commit}\`): nenhum \`before\` é derivado nem estimado. Para declarar a comparação, use \`meta.section35.before\` no raw.`,
    change: `\`N/A\` — o raw não declara mudança de produto; captura no commit \`${commit}\`. Para registrar o que mudou, use \`meta.section35.change\` no raw.`,
    after: "valores desta captura, no mesmo método e regime do `before`:",
    result: resultText(data),
    decision: decisionText(data),
  };

  const lines = [
    SECTION_35_HEADING,
    "",
    "> Bloco **gerado** por `scripts/perf/summarize.mjs` a partir do raw deste",
    "> diretório (`meta.json`, `route-samples.jsonl`, `chat-samples.jsonl`,",
    "> `context-tx.jsonl`, `ai-model-attempts.jsonl`, `bundle-report.json`): nenhum",
    "> número é estimado — o que o raw não tem vira lacuna declarada. O artefato §35",
    "> revisável (método, n, janela, limites e follow-ups) é `perf-evidence.md`, neste",
    "> mesmo diretório.",
    "",
  ];
  for (const label of SECTION_35_LABELS) {
    const declared = declaredLabel(meta, label);
    const value = declared ?? derived[label];
    if (declaredText(value) === null) {
      throw new Error(`§35: rótulo \`${label}\` ficou vazio — o gate reprovaria o report`);
    }
    lines.push(`- **${label}:** ${value}`);
    if (label === "after" && declared === null) {
      for (const part of measuredParts(data)) lines.push(`  - ${part}`);
    }
  }
  lines.push("");
  return lines;
}

function resultText(data) {
  const comparison = declaredComparisonLabels(data.meta ?? {});
  const parts = [
    comparison.length > 0
      ? `referência registrada: o raw declara ${labelList(comparison)} em \`meta.section35\` — o ganho não é calculado pelo gerador (a leitura é do autor)`
      : "referência registrada, **sem alegação de ganho**: não há par antes/depois no mesmo regime",
  ];
  const smallest = rangeText(
    data.routes.map((row) => row.ready.n),
    (value) => String(value),
  );
  if (smallest !== null && Math.min(...data.routes.map((row) => row.ready.n)) < 30) {
    parts.push(`n=${smallest} por rota torna o p95 frágil (< 30)`);
  }
  if (data.chat.samples === 0) {
    parts.push("chat HTTP com n=0: o circuito completo do chat não foi medido");
  }
  if (data.gaps.length > 0) {
    parts.push(`${data.gaps.length} lacuna(s) declarada(s) no raw (ver §Lacunas declaradas)`);
  }
  return `${parts.join("; ")}.`;
}

/**
 * Rótulos de COMPARAÇÃO declarados verbatim no raw (`before`/`change`/`after`),
 * na ordem canônica. Declarar qualquer um deles é uma alegação de comparação: a
 * leitura do ganho passa a ser do AUTOR, então o bloco não pode afirmar ausência
 * de par e a decisão derivada não pode concluir `keep`/`revert` sozinha — só o
 * rótulo realmente declarado é citado (nada de afirmar "par" quando só há
 * `change`).
 */
function declaredComparisonLabels(meta) {
  return ["before", "change", "after"].filter((label) => declaredLabel(meta, label) !== null);
}

/** `["before"]` → `` `before` `` · `["before","change"]` → `` `before` e `change` ``. */
function labelList(labels) {
  const quoted = labels.map((label) => `\`${label}\``);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} e ${quoted.at(-1)}`;
}

/**
 * Decisão derivada do raw. `revert` NUNCA sai daqui: reverter exige julgamento
 * humano e só entra declarado (`meta.section35.decision`). O padrão é `keep`
 * quando a métrica primária (prontidão de rota) foi medida — as lacunas vão
 * declaradas em `result`/§Lacunas —, e `follow-up` quando não há amostra de rota
 * (sem métrica primária não existe referência a adotar) ou quando o raw declara
 * rótulo(s) de comparação sem decisão declarada (o ganho não é calculado aqui).
 */
function decisionText(data) {
  const comparison = declaredComparisonLabels(data.meta ?? {});
  if (comparison.length > 0) {
    return `\`follow-up\` — o raw declara ${labelList(comparison)} em \`meta.section35\` sem decisão declarada: o gerador não calcula ganho nem perda; declare \`meta.section35.decision\` (\`keep\`/\`revert\`) com o julgamento (o artefato §35 revisável é \`perf-evidence.md\`).`;
  }
  const closing =
    "Sem alegação de ganho: não há par antes/depois no mesmo regime (o artefato §35 revisável é `perf-evidence.md`).";
  if (data.routes.length === 0) {
    return `\`follow-up\` — nenhuma amostra de rota medida (métrica primária ausente): re-capturar antes de adotar qualquer referência; ${data.gaps.length} lacuna(s) declarada(s) no raw. ${closing}`;
  }
  const gaps =
    data.gaps.length === 0
      ? "sem lacuna declarada no raw"
      : `${data.gaps.length} lacuna(s) declarada(s) no raw (§Lacunas declaradas)`;
  return `\`keep\` — adotar como referência do regime \`${data.label}\`: métrica primária medida (prontidão de rota, ${data.routes.length} rota(s)), ${gaps}. ${closing}`;
}

/** Renderiza o `report.md` (determinístico, sem dados sensíveis). */
export function renderReport(data) {
  const { meta } = data;
  const lines = [];
  lines.push(`# Baseline de performance ${data.label}`);
  lines.push("");
  lines.push(
    "**Rótulo:** CONTROLADO — preview Nitro local (`node-server`) + PostgreSQL 17 em Docker;",
  );
  lines.push("**não** é produção, **não** usa o gateway real de IA e **não** consome M-06/Q-020.");
  lines.push("");
  lines.push(`- Gerado em: ${data.generatedAt}`);
  lines.push(`- Capturado em: ${meta.startedAt ?? "—"} — ${meta.finishedAt ?? "—"}`);
  lines.push(`- Commit: \`${meta.commit ?? "—"}\``);
  lines.push(`- Base URL: \`${meta.baseUrl ?? "—"}\``);
  lines.push(
    `- Iterações medidas: ${meta.iterations ?? "—"} por rota (warmup: ${meta.warmupIterations ?? 0})`,
  );
  lines.push(`- Playwright: ${meta.playwright ? JSON.stringify(meta.playwright) : "não usado"}`);
  lines.push(`- IA: ${meta.aiMock ? JSON.stringify(meta.aiMock) : "não mockada/indisponível"}`);
  lines.push("");
  lines.push(...section35Lines(data));
  lines.push("## Método");
  lines.push("");
  lines.push(
    "1. `npm run build` (preset `node-server`) e `npm run preview -- --host 127.0.0.1`; stdout do",
  );
  lines.push(
    "   servidor capturado em `server-stdout.txt` (JSON lines `app.context_tx`, `ai.model_attempt`).",
  );
  lines.push("2. Fixture local via `npm run e2e:prepare` (migrations + seed determinístico).");
  lines.push(
    "3. Playwright (chromium) autenticado por Better Auth; por rota: warmup(s) descartado(s) e n amostras.",
  );
  lines.push(
    "4. Tempo de prontidão = do `goto` até o marcador de dados da rota ficar visível (não apenas `load`).",
  );
  lines.push(
    "5. Percentis por interpolação linear R-7: `rank = (p/100) × (n − 1)` entre as amostras ordenadas.",
  );
  lines.push(
    "6. Query count/duração vêm de `app.context_tx` (round trips reais por transação) atribuídos à janela da rota.",
  );
  lines.push("7. Bundle copiado de `.artifacts/bundle-report.json` (saída de `check:bundle`).");
  lines.push("");
  const windowText =
    meta.startedAt && meta.finishedAt
      ? `Janela da captura: **${meta.startedAt} → ${meta.finishedAt}**.`
      : "Janela da captura não registrada.";
  lines.push(windowText);
  lines.push("");
  lines.push(`## ${SECTION_TITLES[0]}`);
  lines.push("");
  if (data.routes.length === 0) {
    lines.push("_Sem amostras de rota — lacuna declarada._");
  } else {
    lines.push("Prontidão (dados visíveis) e TTFB, em ms:");
    lines.push("");
    lines.push(
      ...routeTable(
        data.routes,
        (row) =>
          `| \`${row.route}\` | ${row.ready.n} | ${formatNumber(row.ready.p50)} | ${formatNumber(
            row.ready.p95,
          )} | ${formatNumber(row.ready.min)} | ${formatNumber(row.ready.max)} |`,
      ),
    );
    lines.push("");
    lines.push("TTFB (ms):");
    lines.push("");
    lines.push(
      ...routeTable(
        data.routes,
        (row) =>
          `| \`${row.route}\` | ${row.ttfb.n} | ${formatNumber(row.ttfb.p50)} | ${formatNumber(
            row.ttfb.p95,
          )} | ${formatNumber(row.ttfb.min)} | ${formatNumber(row.ttfb.max)} |`,
      ),
    );
    lines.push("");
    lines.push(
      "Latência dos server functions observada no browser (soma de respostas por amostra):",
    );
    lines.push("");
    lines.push(
      ...routeTable(
        data.routes,
        (row) =>
          `| \`${row.route}\` | ${row.serverFn.n} | ${formatNumber(row.serverFn.p50)} | ${formatNumber(
            row.serverFn.p95,
          )} | ${formatNumber(row.serverFn.min)} | ${formatNumber(row.serverFn.max)} |`,
      ),
    );
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[1]}`);
  lines.push("");
  if (data.query.length === 0) {
    lines.push("_Sem eventos `app.context_tx` atribuídos — lacuna declarada._");
  } else {
    lines.push("| Rota | Eventos de transação | Round trips | Média round trips/evento |");
    lines.push("| ---- | -------------------- | ----------- | ------------------------ |");
    for (const row of data.query) {
      const average = row.events > 0 ? row.roundTrips / row.events : null;
      lines.push(
        `| \`${row.route}\` | ${row.events} | ${row.roundTrips} | ${formatNumber(average, 2)} |`,
      );
    }
    lines.push("");
    lines.push(
      "Round trips = soma de `round_trips` por transação concluída (`commit`/`rollback`) na janela da rota;",
    );
    lines.push(
      "inclui as queries do Better Auth/sessão que rodam dentro da transação do server fn.",
    );
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[2]}`);
  lines.push("");
  if (data.query.length === 0) {
    lines.push("_Sem eventos `app.context_tx` atribuídos — lacuna declarada._");
  } else {
    lines.push("Duração da transação (`duration_ms`), em ms:");
    lines.push("");
    lines.push(
      ...routeTable(
        data.query,
        (row) =>
          `| \`${row.route}\` | ${row.duration.n} | ${formatNumber(row.duration.p50)} | ${formatNumber(
            row.duration.p95,
          )} | ${formatNumber(row.duration.min)} | ${formatNumber(row.duration.max)} |`,
      ),
    );
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[3]}`);
  lines.push("");
  const dashboard = data.routes.find((row) => row.route === "/inicio");
  if (!dashboard) {
    lines.push("_Rota `/inicio` sem amostras — lacuna declarada._");
  } else {
    lines.push(
      `Dashboard (\`/inicio\`): prontidão p50 **${formatNumber(dashboard.ready.p50)} ms** / p95 **${formatNumber(
        dashboard.ready.p95,
      )} ms** (n=${dashboard.ready.n}); TTFB p50 ${formatNumber(dashboard.ttfb.p50)} ms.`,
    );
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[4]}`);
  lines.push("");
  const products = data.routes.find((row) => row.route === "/produtos");
  if (!products) {
    lines.push("_Rota `/produtos` sem amostras — lacuna declarada._");
  } else {
    lines.push(
      `Lista de produtos (\`/produtos\`): prontidão p50 **${formatNumber(products.ready.p50)} ms** / p95 **${formatNumber(
        products.ready.p95,
      )} ms** (n=${products.ready.n}); server fn p50 ${formatNumber(products.serverFn.p50)} ms.`,
    );
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[5]}`);
  lines.push("");
  if (data.ai.latency.n === 0) {
    lines.push("_Nenhum `ai.model_attempt` com outcome `success` — lacuna declarada._");
  } else {
    lines.push(
      `AI latency (mock local): n=${data.ai.latency.n}, p50 **${formatNumber(
        data.ai.latency.p50,
      )} ms**, p95 **${formatNumber(data.ai.latency.p95)} ms**, min ${formatNumber(
        data.ai.latency.min,
      )} / max ${formatNumber(data.ai.latency.max)} ms.`,
    );
    lines.push("");
    if (data.ai.byModel.length > 0) {
      lines.push("| Modelo | n | p50 | p95 |");
      lines.push("| ------ | - | --- | --- |");
      for (const model of data.ai.byModel) {
        lines.push(
          `| \`${model.model}\` | ${model.n} | ${formatNumber(model.p50)} | ${formatNumber(model.p95)} |`,
        );
      }
      lines.push("");
    }
    lines.push(`Outcomes observados: ${JSON.stringify(data.ai.byOutcome)}`);
    lines.push(`Origem das amostras: ${JSON.stringify(data.ai.bySource)}`);
    if (data.ai.bySource["direct-probe"] && !data.ai.bySource["chat-http"]) {
      lines.push("");
      lines.push(
        "> Aviso: as amostras vieram da sonda direta da camada de modelo (`callModel`), não do",
      );
      lines.push(
        "> caminho HTTP do chat — o harness registrou a indisponibilidade em Lacunas. A latência",
      );
      lines.push("> cobre fetch mockado + retry/timeout/telemetria, sem auth/budget/DB do chat.");
    }
    lines.push("");
    lines.push(
      `Chat completo (round trip do envio até a resposta): n=${data.chat.samples}, p50 ${formatNumber(
        data.chat.send.p50,
      )} ms, p95 ${formatNumber(data.chat.send.p95)} ms.`,
    );
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[6]}`);
  lines.push("");
  if (!data.bundle) {
    lines.push("_`bundle-report.json` ausente — lacuna declarada._");
  } else {
    lines.push(`Budget: ${JSON.stringify(data.bundle.budget)}`);
    lines.push("");
    lines.push("| Entry | Minified | gzip | Brotli | Grafo inicial (min) | Budget |");
    lines.push("| ----- | -------- | ---- | ------ | ------------------- | ------ |");
    for (const entry of data.bundle.entries) {
      lines.push(
        `| \`${entry.file}\` | ${bytes(entry.minifiedBytes)} | ${bytes(entry.gzipBytes)} | ${bytes(
          entry.brotliBytes,
        )} | ${bytes(entry.initialGraph?.minifiedBytes)} | ${entry.passed ? "PASS" : "FAIL"} |`,
      );
    }
  }
  lines.push("");
  lines.push(`## ${SECTION_TITLES[7]}`);
  lines.push("");
  if (data.routes.length === 0) {
    lines.push("_Sem amostras de rota — lacuna declarada._");
  } else {
    lines.push("| Rota | LCP p50 | LCP p95 | CLS p50 | CLS p95 | FCP p50 | Load p50 |");
    lines.push("| ---- | ------- | ------- | ------- | ------- | ------- | -------- |");
    for (const row of data.routes) {
      lines.push(
        `| \`${row.route}\` | ${formatNumber(row.lcp.p50)} | ${formatNumber(row.lcp.p95)} | ${formatNumber(
          row.cls.p50,
          4,
        )} | ${formatNumber(row.cls.p95, 4)} | ${formatNumber(row.fcp.p50)} | ${formatNumber(
          row.load.p50,
        )} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Decisões");
  lines.push("");
  lines.push(
    "- Baseline rotulado **CONTROLADO**: preview Nitro local + PostgreSQL em Docker; nenhum tráfego de produção, nenhuma chamada ao gateway real.",
  );
  lines.push(
    "- Prontidão de rota = marcador de dados visível (não `load`); o HTML inicial das rotas autenticadas é só o shell (`ssr: false`).",
  );
  const routeMarkers = Array.isArray(meta.routes) ? meta.routes : [];
  for (const route of routeMarkers) {
    if (typeof route === "string") lines.push(`  - \`${route}\``);
    else lines.push(`  - \`${route.path}\` → \`${route.ready}\``);
  }
  lines.push(
    "- Item 6 (AI latency) medido com provider mockado; quando o chat HTTP está inviável, a fonte é a sonda direta da camada de modelo (declarada em Lacunas).",
  );
  lines.push(
    "- Percentis por interpolação linear R-7; query count/duração vêm de `app.context_tx`, incluindo auth/sessão dentro da transação.",
  );
  lines.push(
    "- Raw re-derivável gravado como `.json/.jsonl/.txt` no diretório da evidência; `report.md` é regenerado por `scripts/perf/summarize.mjs`.",
  );
  lines.push("");
  lines.push("## Limitações");
  lines.push("");
  lines.push(
    "- **Mock de IA ≠ gateway real:** o circuito de chat responde de um provider mockado em processo",
  );
  lines.push(
    "  (latência artificial determinística). Os números de AI latency medem o caminho interno do app",
  );
  lines.push("  (retry, timeout, ledger, persistência), não a rede/vendor do gateway.");
  lines.push(
    "- **Local ≠ Neon:** PostgreSQL 17 em Docker no loopback, latência de rede ~0; Neon tem",
  );
  lines.push("  latência de região, connection pooling e autoscaling que não aparecem aqui.");
  lines.push("- **n pequeno:** percentis p95 com n=5 são indicativos; não use como SLO.");
  lines.push(
    "- **TTFB/ready inclui o browser** (Playwright, cold context por rota) e o roteamento",
  );
  lines.push("  client-side (`ssr: false` nas rotas autenticadas): o HTML inicial é só o shell.");
  lines.push("- **M-06/Q-020 não consumidos:** nenhum tráfego real ou de produção foi tocado.");
  lines.push("");
  lines.push("## Lacunas declaradas");
  lines.push("");
  if (data.gaps.length === 0) {
    lines.push("- Nenhuma lacuna registrada.");
  } else {
    for (const gap of data.gaps) lines.push(`- ${gap}`);
  }
  lines.push("");
  lines.push("## Raw versionado");
  lines.push("");
  lines.push("- `meta.json` — ambiente/janela/lacunas da captura");
  lines.push("- `route-samples.jsonl` — amostras por rota (prontidão, TTFB, LCP, CLS, server fn)");
  lines.push("- `chat-samples.jsonl` — round trips do chat");
  lines.push("- `context-tx.jsonl` — eventos `app.context_tx` atribuídos por fase");
  lines.push("- `ai-model-attempts.jsonl` — eventos `ai.model_attempt`");
  lines.push("- `server-stdout.txt` — stdout/stderr do preview Nitro");
  lines.push("- `build-output.txt` — saída do build");
  lines.push("- `bundle-report.json` — cópia de `.artifacts/bundle-report.json`");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function readJsonl(file) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Formata o markdown com o Prettier do próprio repo (mesma config que o gate
 * `format:check` usa) para que o artefato gerado seja versionável sem red.
 * Se o Prettier não estiver disponível, devolve o markdown como está.
 */
async function formatMarkdown(markdown, filePath) {
  try {
    const prettier = await import("prettier");
    const config = (await prettier.resolveConfig(filePath)) ?? {};
    return await prettier.format(markdown, { ...config, parser: "markdown" });
  } catch {
    return markdown;
  }
}

/** Lê o diretório de evidência, monta e grava `report.md`. */
export async function summarizeDir(dir = defaultEvidenceDir) {
  const meta = (await readJsonOrNull(path.join(dir, "meta.json"))) ?? {};
  const [routeSamples, chatSamples, contextTx, aiAttempts, bundleReport] = await Promise.all([
    readJsonl(path.join(dir, "route-samples.jsonl")),
    readJsonl(path.join(dir, "chat-samples.jsonl")),
    readJsonl(path.join(dir, "context-tx.jsonl")),
    readJsonl(path.join(dir, "ai-model-attempts.jsonl")),
    readJsonOrNull(path.join(dir, "bundle-report.json")),
  ]);
  const report = summarize({
    meta,
    routeSamples,
    chatSamples,
    contextTx,
    aiAttempts,
    bundleReport,
  });
  const reportPath = path.join(dir, "report.md");
  await writeFile(reportPath, await formatMarkdown(renderReport(report), reportPath));
  return { reportPath, report };
}

export function parseArgs(argv) {
  const options = { dir: defaultEvidenceDir };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--dir exige um caminho");
      options.dir = path.resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Uso: node scripts/perf/summarize.mjs [--dir <diretório-da-evidência>]");
    return 0;
  }
  const { reportPath, report } = await summarizeDir(options.dir);
  console.log(
    `report.md gerado em ${path.relative(root, reportPath)} (${report.routes.length} rotas, ${report.query.length} rotas com query, ${report.ai.latency.n} amostras de IA).`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
