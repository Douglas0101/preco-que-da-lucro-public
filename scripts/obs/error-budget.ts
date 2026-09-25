/**
 * §30 — Error budget (medição mínima, local-first).
 *
 * Lê JSONL de logs estruturados (`request.completed`/`request.failed`/`ai.*`,
 * `src/lib/structured-logger.ts:43-59`) e, opcionalmente, linhas de métrica
 * exportadas (`app.financial.states`, `app.ai.timeouts`), agrega por `code`
 * dentro da janela pedida, compara o consumo com as tolerâncias DRAFT de
 * `docs/specs/M-06/error-budget.md` e grava
 * `docs/evidence/error-budget-<janela>.md`.
 *
 * Fail-closed: abaixo de `--min-requests` o veredito é INSUFFICIENT (exit 2);
 * antes do baseline M-06 a classe de IA transitória fica em DRAFT (exit 2) e
 * nenhum rótulo CONTROLADO é emitido.
 *
 * Uso:
 *   npx tsx scripts/obs/error-budget.ts --input=logs.jsonl --window=7d
 *   cat logs.jsonl | npx tsx scripts/obs/error-budget.ts --window=24h
 *
 * Exit: 0 = todas as classes OK; 1 = budget excedido; 2 = fail-closed
 * (N insuficiente, classe sem sinal ou tolerância sem baseline ratificado).
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_WINDOW = "7d";
export const DEFAULT_MIN_REQUESTS = 100;

/** Tolerância candidata de IA transitória (§30): 1% em 7 d, só após baseline. */
export const AI_TOLERANCE_RATE = 0.01;

const WINDOW_UNITS_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const WINDOW_PATTERN = /^(\d+)(s|m|h|d)$/;

const ROOT_CAUSE_PROMPT = "docs/specs/M-06/error-budget.md";

export interface Args {
  help: boolean;
  input?: string;
  window: string;
  windowMs: number;
  minRequests: number;
  baseline: string | null;
  out: string;
}

export interface EventRecord {
  timestamp: number;
  event: string;
  code: string | null;
  status: number | null;
  correlationId: string | null;
  pathname: string | null;
  state: string | null;
}

export type BudgetBucket = "financial_critical" | "ai_transient" | "server_fault";

export type Disposition = BudgetBucket | "excluded" | "monitored" | "ok";

export interface Classification {
  disposition: Disposition;
  code: string;
}

export interface CodeCount {
  code: string;
  bucket: BudgetBucket;
  count: number;
}

export interface SimpleCodeCount {
  code: string;
  count: number;
}

const BUDGET_BUCKET_LABELS: Readonly<Record<BudgetBucket, string>> = {
  financial_critical: "financeiro",
  ai_transient: "IA",
  server_fault: "servidor",
};

export interface ClassResult {
  id: BudgetBucket;
  label: string;
  signal: string;
  basisLabel: string;
  basis: number;
  consumption: number;
  toleranceDisplay: string;
  verdict: "OK" | "EXHAUSTED" | "UNKNOWN" | "DRAFT";
  detail: string;
}

export interface ErrorBudgetReport {
  generatedAt: string;
  source: string;
  window: { token: string; ms: number; start: string | null; end: string | null };
  parsed: { lines: number; parsed: number; skipped: number };
  requests: { total: number; completed: number; failed: number; chat: number; healthy: number };
  minimumRequests: number;
  baseline: string | null;
  classes: ClassResult[];
  codes: CodeCount[];
  excluded: SimpleCodeCount[];
  monitored: SimpleCodeCount[];
  aiMetricTimeouts: number;
  financialSignals: number;
  verdict: "OK" | "FAIL" | "INSUFFICIENT" | "INDETERMINATE";
  exitCode: 0 | 1 | 2;
  notes: string[];
}

const USAGE = `Usage: npx tsx scripts/obs/error-budget.ts [options]

Lê JSONL (stdin ou --input) de request.completed/request.failed/ai.* e linhas
de métrica app.financial.states/app.ai.timeouts; grava
docs/evidence/error-budget-<janela>.md (DRAFT até Q-020).

Options:
  --input=<arquivo.jsonl>   fixture/log de entrada (default: stdin)
  --window=<dur>            janela relativa ao último timestamp (s|m|h|d; default: ${DEFAULT_WINDOW})
  --min-requests=<n>        N mínimo de requests na janela (default: ${DEFAULT_MIN_REQUESTS})
  --baseline=<ref>          ref do baseline M-06 que ratifica a tolerância de IA
  --out=<arquivo.md>        saída (default: docs/evidence/error-budget-<janela>.md)
  --help                    esta ajuda

Exit: 0 OK · 1 budget excedido · 2 fail-closed (N insuficiente/sem sinal/sem baseline)
`;

function requireValue(argument: string, name: string): string {
  const value = argument.slice(name.length + 1).trim();
  if (value === "") throw new Error(`${name} não pode ser vazio`);
  return value;
}

export function parseWindow(window: string): number {
  const match = WINDOW_PATTERN.exec(window.trim());
  if (!match)
    throw new Error(`--window inválida: "${window}" (use s|m|h|d, ex.: ${DEFAULT_WINDOW})`);
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--window inválida: "${window}"`);
  return value * WINDOW_UNITS_MS[unit]!;
}

export function parseArgs(argv: readonly string[]): Args {
  let help = false;
  let input: string | undefined;
  let window = DEFAULT_WINDOW;
  let minRequests = DEFAULT_MIN_REQUESTS;
  let baseline: string | null = null;
  let out: string | undefined;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument.startsWith("--input=")) {
      input = requireValue(argument, "--input");
    } else if (argument.startsWith("--window=")) {
      window = requireValue(argument, "--window");
      parseWindow(window);
    } else if (argument.startsWith("--min-requests=")) {
      minRequests = Number(requireValue(argument, "--min-requests"));
      if (!Number.isInteger(minRequests) || minRequests <= 0) {
        throw new Error("--min-requests exige um inteiro positivo");
      }
    } else if (argument.startsWith("--baseline=")) {
      baseline = requireValue(argument, "--baseline");
    } else if (argument.startsWith("--out=")) {
      out = requireValue(argument, "--out");
    } else {
      throw new Error(`argumento desconhecido: ${argument}`);
    }
  }
  return {
    help,
    input,
    window,
    windowMs: parseWindow(window),
    minRequests,
    baseline,
    out: out ?? `docs/evidence/error-budget-${window}.md`,
  };
}

export function parseRecords(rawText: string): {
  records: EventRecord[];
  lines: number;
  skipped: number;
} {
  const records: EventRecord[] = [];
  let lines = 0;
  let skipped = 0;
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    lines++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      skipped++;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const event = record.event;
    const timestamp =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    if (typeof event !== "string" || event === "" || !Number.isFinite(timestamp)) {
      skipped++;
      continue;
    }
    records.push({
      timestamp,
      event,
      code: typeof record.code === "string" ? record.code : null,
      status: typeof record.status === "number" ? record.status : null,
      correlationId: typeof record.correlationId === "string" ? record.correlationId : null,
      pathname: typeof record.pathname === "string" ? record.pathname : null,
      state: typeof record.state === "string" ? record.state : null,
    });
  }
  return { records, lines, skipped };
}

/**
 * Códigos fora do budget: 4xx de validação/auth/cliente e quota de IA
 * (429 não-retryable) não medem disponibilidade do serviço (ADR-022).
 */
export const EXCLUDED_CODES: ReadonlySet<string> = new Set([
  "VALIDATION_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMIT",
  "AI_QUOTA",
]);

export function classifyRecord(
  record: EventRecord,
  aiCorrelationIds: ReadonlySet<string>,
): Classification {
  if (record.event === "request.completed") {
    if (record.status !== null && record.status >= 500) {
      return { disposition: "server_fault", code: "HTTP_5XX" };
    }
    if (record.status !== null && record.status >= 400) {
      return { disposition: "excluded", code: "HTTP_4XX" };
    }
    return { disposition: "ok", code: "HTTP_OK" };
  }
  if (record.event === "request.failed") {
    const code = record.code ?? "UNKNOWN_ERROR";
    if (EXCLUDED_CODES.has(code)) return { disposition: "excluded", code };
    if (code === "AI_TIMEOUT") return { disposition: "ai_transient", code };
    if (code === "DEPENDENCY_ERROR") {
      const isChat =
        (record.correlationId !== null && aiCorrelationIds.has(record.correlationId)) ||
        (record.pathname ?? "").toLowerCase().includes("chat");
      return { disposition: isChat ? "ai_transient" : "server_fault", code };
    }
    return { disposition: "server_fault", code };
  }
  if (record.event === "app.financial.states") {
    if (record.state === "invalid") {
      return { disposition: "financial_critical", code: "FINANCIAL_STATE_INVALID" };
    }
    if (record.state === "incomplete") {
      return { disposition: "monitored", code: "FINANCIAL_STATE_INCOMPLETE" };
    }
    return { disposition: "ok", code: "FINANCIAL_STATE_OK" };
  }
  if (record.event === "app.ai.timeouts") {
    return { disposition: "monitored", code: "AI_TIMEOUT_METRIC" };
  }
  return { disposition: "ok", code: "IGNORED" };
}

function maxTimestamp(records: readonly EventRecord[]): number | null {
  let max: number | null = null;
  for (const record of records) {
    if (max === null || record.timestamp > max) max = record.timestamp;
  }
  return max;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const [integer, fraction] = value.toString().split(".");
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped},${fraction}`;
}

function formatRate(rate: number): string {
  return `${formatNumber(Number((rate * 100).toFixed(4)))}%`;
}

function codeCountsToArray(counts: ReadonlyMap<string, CodeCount>): CodeCount[] {
  const order: BudgetBucket[] = ["financial_critical", "ai_transient", "server_fault"];
  return [...counts.values()].sort(
    (a, b) =>
      order.indexOf(a.bucket) - order.indexOf(b.bucket) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );
}

export function buildReport(rawText: string, args: Args, source = "<stdin>"): ErrorBudgetReport {
  const parsedInput = parseRecords(rawText);
  const anchor = maxTimestamp(parsedInput.records);
  const windowStart = anchor === null ? null : anchor - args.windowMs;
  const inWindow =
    anchor === null
      ? []
      : parsedInput.records.filter(
          (record) => record.timestamp >= windowStart! && record.timestamp <= anchor,
        );

  const aiCorrelationIds = new Set<string>();
  const timeoutCorrelationIds = new Set<string>();
  for (const record of inWindow) {
    if (record.event.startsWith("ai.") && record.correlationId !== null) {
      aiCorrelationIds.add(record.correlationId);
    }
    if (record.event === "request.failed" && record.code === "AI_TIMEOUT") {
      if (record.correlationId !== null) timeoutCorrelationIds.add(record.correlationId);
    }
  }

  const bucketCounts: Record<BudgetBucket, number> = {
    financial_critical: 0,
    ai_transient: 0,
    server_fault: 0,
  };
  const budgetCodes = new Map<string, CodeCount>();
  const excludedCodes = new Map<string, SimpleCodeCount>();
  let requests = 0;
  let completed = 0;
  let failed = 0;
  let clientErrors = 0;
  let financialSignals = 0;
  let aiMetricTimeouts = 0;
  let financialIncomplete = 0;

  for (const record of inWindow) {
    if (record.event === "request.completed") {
      completed++;
      requests++;
      if (record.status !== null && record.status >= 400 && record.status < 500) clientErrors++;
    }
    if (record.event === "request.failed") {
      failed++;
      requests++;
    }
    if (record.event === "app.financial.states") financialSignals++;
    if (record.event === "app.ai.timeouts") aiMetricTimeouts++;

    const classification = classifyRecord(record, aiCorrelationIds);
    if (classification.disposition === "excluded") {
      const entry = excludedCodes.get(classification.code);
      if (entry) entry.count++;
      else excludedCodes.set(classification.code, { code: classification.code, count: 1 });
      continue;
    }
    if (classification.disposition === "monitored") {
      if (classification.code === "FINANCIAL_STATE_INCOMPLETE") financialIncomplete++;
      continue;
    }
    if (classification.disposition === "ok") continue;
    bucketCounts[classification.disposition]++;
    const key = `${classification.disposition}:${classification.code}`;
    const entry = budgetCodes.get(key);
    if (entry) entry.count++;
    else
      budgetCodes.set(key, {
        code: classification.code,
        bucket: classification.disposition,
        count: 1,
      });
  }

  const chatRequests = new Set<string>([...aiCorrelationIds, ...timeoutCorrelationIds]).size;
  const aiConsumption = Math.max(bucketCounts.ai_transient, aiMetricTimeouts);
  const aiToleranceCount = AI_TOLERANCE_RATE * chatRequests;

  const financialVerdict: ClassResult["verdict"] =
    financialSignals === 0 ? "UNKNOWN" : bucketCounts.financial_critical > 0 ? "EXHAUSTED" : "OK";
  const financialDetail =
    financialSignals === 0
      ? "sem linhas `app.financial.states` no input: counter OTEL-only hoje; exporte a série para JSONL (runbook) — fail-closed"
      : `${bucketCounts.financial_critical} estado(s) \`invalid\` em ${financialSignals} sinal(is) de métrica`;

  const aiVerdict: ClassResult["verdict"] =
    chatRequests === 0
      ? "UNKNOWN"
      : args.baseline === null
        ? "DRAFT"
        : aiConsumption <= aiToleranceCount
          ? "OK"
          : "EXHAUSTED";
  const aiDetail =
    chatRequests === 0
      ? "sem requisições de chat na janela"
      : `${bucketCounts.ai_transient} falha(s) de envelope · métrica \`app.ai.timeouts\` = ${aiMetricTimeouts} (consumo = max)`;

  const classes: ClassResult[] = [
    {
      id: "financial_critical",
      label: "Financeiro crítico (`app.financial.states{state=invalid}` em caminho do usuário)",
      signal: "linhas `app.financial.states` com `state=invalid`",
      basisLabel: "sinais de métrica",
      basis: financialSignals,
      consumption: bucketCounts.financial_critical,
      toleranceDisplay: "0 (zero estrutural)",
      verdict: financialVerdict,
      detail: financialDetail,
    },
    {
      id: "ai_transient",
      label: "IA transitória (`AI_TIMEOUT`/`DEPENDENCY_ERROR` de chat + `app.ai.timeouts`)",
      signal: "`request.failed` de chat e métrica `app.ai.timeouts`",
      basisLabel: "requisições de chat",
      basis: chatRequests,
      consumption: aiConsumption,
      toleranceDisplay:
        args.baseline === null
          ? `candidata ${formatRate(AI_TOLERANCE_RATE)} em ${args.window} (não ratificada)`
          : `${formatRate(AI_TOLERANCE_RATE)} de ${formatNumber(chatRequests)} = ${formatNumber(Number(aiToleranceCount.toFixed(4)))}`,
      verdict: aiVerdict,
      detail: aiDetail,
    },
    {
      id: "server_fault",
      label: "Falha de servidor/dependência (`DATABASE_ERROR`/`INTERNAL_ERROR`/5xx)",
      signal: "`request.failed` e `request.completed` com status ≥ 500",
      basisLabel: "requests totais",
      basis: requests,
      consumption: bucketCounts.server_fault,
      toleranceDisplay: "0 (zero estrutural, revisível no baseline)",
      verdict: bucketCounts.server_fault > 0 ? "EXHAUSTED" : "OK",
      detail: `${bucketCounts.server_fault} falha(s) de servidor/dependência`,
    },
  ];

  const notes: string[] = [];
  if (financialSignals === 0) {
    notes.push(
      "Sem sinal financeiro: `app.financial.states` é um counter OTEL e só é medido aqui quando a série é exportada para JSONL; sem export a classe permanece UNKNOWN (fail-closed).",
    );
  }
  if (args.baseline === null) {
    notes.push(
      `Tolerância de IA transitória (${formatRate(AI_TOLERANCE_RATE)} em ${args.window}) é candidata: ratificação só em Q-020 com baseline M-06; nenhum rótulo CONTROLADO antes disso.`,
    );
  }
  if (aiMetricTimeouts > 0) {
    notes.push(
      "Consumo de IA usa o máximo entre falhas de envelope e `app.ai.timeouts` para não subcontabilizar abortos.",
    );
  }
  if (parsedInput.skipped > 0) {
    notes.push(
      `${parsedInput.skipped} linha(s) sem JSON/timestamp/event foram ignoradas de ${parsedInput.lines} linhas não vazias.`,
    );
  }

  let verdict: ErrorBudgetReport["verdict"];
  let exitCode: ErrorBudgetReport["exitCode"];
  if (classes.some((entry) => entry.verdict === "EXHAUSTED")) {
    verdict = "FAIL";
    exitCode = 1;
  } else if (requests < args.minRequests) {
    verdict = "INSUFFICIENT";
    exitCode = 2;
    notes.push(
      `fail-closed: N=${requests} < --min-requests=${args.minRequests}; nenhum veredito verde é emitido.`,
    );
  } else if (classes.some((entry) => entry.verdict === "UNKNOWN" || entry.verdict === "DRAFT")) {
    verdict = "INDETERMINATE";
    exitCode = 2;
  } else {
    verdict = "OK";
    exitCode = 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    source,
    window: {
      token: args.window,
      ms: args.windowMs,
      start: windowStart === null ? null : new Date(windowStart).toISOString(),
      end: anchor === null ? null : new Date(anchor).toISOString(),
    },
    parsed: {
      lines: parsedInput.lines,
      parsed: parsedInput.records.length,
      skipped: parsedInput.skipped,
    },
    requests: {
      total: requests,
      completed,
      failed,
      chat: chatRequests,
      healthy: completed - clientErrors,
    },
    minimumRequests: args.minRequests,
    baseline: args.baseline,
    classes,
    codes: codeCountsToArray(budgetCodes),
    excluded: [...excludedCodes.values()].sort(
      (a, b) => b.count - a.count || a.code.localeCompare(b.code),
    ),
    monitored: [
      { code: "FINANCIAL_STATE_INCOMPLETE", count: financialIncomplete },
      { code: "AI_TIMEOUT_METRIC", count: aiMetricTimeouts },
    ],
    aiMetricTimeouts,
    financialSignals,
    verdict,
    exitCode,
    notes,
  };
}

function renderTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => (cell ?? "").padEnd(widths[column]!)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(Math.max(3, width))).join(" | ")} |`;
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

export function renderReport(report: ErrorBudgetReport): string {
  const lines: string[] = [
    `# Error budget — janela \`${report.window.token}\``,
    "",
    "**DRAFT / NÃO-RATIFICADO** — tolerâncias candidatas; nada de rótulo CONTROLADO antes do",
    "baseline M-06/Q-020. Política: `docs/specs/M-06/error-budget.md`; taxonomia: ADR-022.",
    "",
    `- Gerado em: ${report.generatedAt}`,
    `- Fonte: \`${report.source}\``,
    `- Janela: \`${report.window.token}\` → ${report.window.start ?? "n/d"} → ${report.window.end ?? "n/d"}`,
    `- Linhas: ${formatNumber(report.parsed.lines)} (parseadas: ${formatNumber(report.parsed.parsed)} · ignoradas: ${formatNumber(report.parsed.skipped)})`,
    `- Requests na janela: ${formatNumber(report.requests.total)} (mínimo ${formatNumber(report.minimumRequests)}) · chat: ${formatNumber(report.requests.chat)} · falhas: ${formatNumber(report.requests.failed)} · saudáveis: ${formatNumber(report.requests.healthy)}`,
    `- Baseline M-06: ${report.baseline === null ? "não declarado" : `\`${report.baseline}\``}`,
    `- **Veredito: ${report.verdict}** (exit ${report.exitCode})`,
    "",
    "## Classes",
    "",
    renderTable(
      ["Classe", "Base", "Consumo", "Tolerância", "Veredito"],
      report.classes.map((entry) => [
        entry.label,
        `${entry.basisLabel}: ${formatNumber(entry.basis)}`,
        formatNumber(entry.consumption),
        entry.toleranceDisplay,
        entry.verdict,
      ]),
    ),
    "",
    "## Consumo por código",
    "",
  ];

  if (report.codes.length === 0) {
    lines.push("Nenhum código consumiu budget na janela.", "");
  } else {
    lines.push(
      renderTable(
        ["Classe", "Código", "N"],
        report.codes.map((entry) => [
          BUDGET_BUCKET_LABELS[entry.bucket],
          entry.code,
          formatNumber(entry.count),
        ]),
      ),
      "",
    );
  }

  lines.push("## Excluídos do budget (não consomem)", "");
  lines.push(
    report.excluded.length === 0
      ? "Nenhum evento excluído na janela."
      : renderTable(
          ["Código", "N"],
          report.excluded.map((entry) => [entry.code, formatNumber(entry.count)]),
        ),
    "",
    "## Monitorados (não consomem)",
    "",
    renderTable(
      ["Sinal", "N"],
      report.monitored.map((entry) => [entry.code, formatNumber(entry.count)]),
    ),
    "",
    "## Detalhe por classe",
    "",
  );
  for (const entry of report.classes) {
    lines.push(`- **${entry.label}** — ${entry.detail}`);
  }

  lines.push("", "## Notas", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push(
    "",
    "## Referências",
    "",
    `- Política: \`${ROOT_CAUSE_PROMPT}\``,
    "- Taxonomia de erros: `docs/adr/ADR-022-error-taxonomy-observability.md`",
    "- Degradação graciosa (IA indisponível): Plano Mestre §31",
    "- Apuração/escalonamento: `docs/runbooks/slo-error-budget.md`",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const rawText = args.input ? readFileSync(args.input, "utf8") : readFileSync(0, "utf8");
  const report = buildReport(rawText, args, args.input ?? "<stdin>");
  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  const { format } = await import("prettier");
  const markdown = await format(renderReport(report), { parser: "markdown" });
  await writeFile(outPath, markdown, "utf8");
  console.log(
    `error-budget (${report.window.token}): ${report.verdict} (exit ${report.exitCode}) → ${args.out}`,
  );
  for (const entry of report.classes) {
    console.log(
      `error-budget: ${entry.id} consumo=${entry.consumption} base=${entry.basis} → ${entry.verdict}`,
    );
  }
  process.exitCode = report.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(`error-budget: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
