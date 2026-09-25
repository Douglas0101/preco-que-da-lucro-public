/**
 * Coletor local de `pg_stat_statements` (§16.3): lê `calls`, `total_exec_time`,
 * `mean_exec_time`, `rows` e `query` das queries críticas do §16.4 e emite
 * top-N por tempo total, com **parâmetros redigidos** (nunca o texto cru) e
 * agregação de todas as entradas que casam com cada alvo.
 *
 * Alvos: o SQL **real** que os repositórios drizzle do app montam —
 * `src/server/repositories/product.repository.ts:29-38` (products.list),
 * `src/server/repositories/purchase-price.repository.ts:56-71`
 * (purchasePrice.latest) e `src/server/repositories/dashboard.repository.ts:50-57`
 * (dashboard.productIngredients; `inArray` renderiza `in ($1, $2, ...)`, então o
 * mesmo alvo aparece em mais de uma entrada conforme o tamanho do array e é
 * somado aqui).
 *
 * Local-only por contrato (mesma disciplina de `scripts/obs/pool-activity.ts`):
 * recusa `NODE_ENV=production` e host que não seja loopback
 * (127.0.0.1/localhost/::1) — o host validado é o que o driver vai usar
 * (`pg-connection-string`, que honra `?host=`), não apenas o da URL. Nunca
 * imprime nem grava a URL de conexão.
 *
 * A extensão não é habilitada aqui: o coletor só mede ambiente onde
 * `shared_preload_libraries=pg_stat_statements` + `CREATE EXTENSION` já rodaram
 * (container efêmero de medição). Ver
 * `docs/evidence/pg-stat-statements-2026-09-15.md`.
 *
 * Uso:
 *   DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5435/pqdl_pgstat \
 *     npx tsx scripts/obs/pg-stat-statements.ts [--top=10]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { normalizeSqlOperation, redactSqlText } from "../../src/instrumentation/sql-redactor";

const EVIDENCE_DIR = "docs/evidence/pg-stat-statements";

/** Hosts aceitos: o banco precisa estar no loopback da própria máquina. */
export const LOCAL_HOSTNAMES: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
};

export const DEFAULT_TOP_N = 10;
export const MAX_TOP_N = 50;

/** Regime do artefato: harness local com dataset sintético — nunca `OBSERVED`. */
export const REGIME = "CONTROLLED";

/**
 * Teto da redação. O Postgres guarda no máximo `track_activity_query_size`
 * bytes (1024 por default), então redigir com esse teto mostra o SQL inteiro e
 * evita que duas queries distintas colapsem no mesmo prefixo truncado.
 */
export const STATS_REDACTION_MAX_LENGTH = 1024;

/** Linha crua de `pg_stat_statements` (bigint chega como string pelo driver). */
export interface StatRow {
  query: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  rows: number;
}

export interface CriticalTarget {
  label: string;
  /** Repositório que monta o SQL real deste alvo (`arquivo:linha`). */
  source: string;
  /** Casa com o SQL normalizado (`normalizeQuery`) renderizado pelo drizzle. */
  pattern: RegExp;
}

/** Uma linha do relatório: agregado de todas as entradas com o mesmo texto
 * redigido. Não carrega o SQL cru — o texto sai sempre redigido. */
export interface ReportRow {
  critical: string | null;
  operation: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  rows: number;
  /** Quantas entradas de `pg_stat_statements` foram somadas nesta linha. */
  statements: number;
  redacted_query: string;
}

/** Agregado de um alvo crítico — junta todas as formas que casaram com ele. */
export interface CriticalReport {
  label: string;
  source: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  rows: number;
  statements: number;
  shapes: string[];
}

export interface Report {
  /** Quantidade de padrões distintos depois da agregação. */
  patterns: number;
  top: ReportRow[];
  critical: CriticalReport[];
  missingCritical: string[];
}

export interface ArtifactMeta {
  generatedAt: string;
  host: string;
  database: string;
  topN: number;
  statementEntries: number;
  report: Report;
}

const STATEMENTS_SQL = `
  select
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    rows
  from pg_stat_statements
  where dbid = (select oid from pg_database where datname = current_database())
    and query not like '%pg_stat_statements%'
  order by total_exec_time desc
`;

/**
 * Normaliza SQL para casar com o que o Postgres guarda **e** com o que o
 * drizzle renderiza: minúsculas; aspas de identificador fora; qualificador
 * `tabela.` fora; placeholders em forma canônica `$0` (a numeração não é
 * estável — `limit 1` vira `limit $3`, e `in ($2, $3)` varia com o array);
 * espaços colapsados. O espaçamento em volta de `(`, `)`, `,` e `=` fica por
 * conta dos padrões dos alvos (`\s*`), para que a forma normalizada continue
 * legível ao lado do SQL do repositório.
 */
export function normalizeQuery(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/\b[a-z_][a-z0-9_]*\./g, "")
    .replace(/\$\d+/g, "$0")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
}

/** As três queries críticas do §16.4, com o SQL real do app e sua origem. */
export const CRITICAL_QUERIES: readonly CriticalTarget[] = [
  {
    label: "products.list",
    source: "src/server/repositories/product.repository.ts:30-37",
    pattern:
      /^select .+ from products where\s*\(?\s*tenant_id = \$0 and archived_at is null\s*\)?\s*order by created_at desc$/,
  },
  {
    label: "purchasePrice.latest",
    source: "src/server/repositories/purchase-price.repository.ts:66-71",
    pattern:
      /^select .+ from purchase_price_history where\s*\(?\s*tenant_id = \$0 and ingredient_id = \$0\s*\)?\s*order by valid_from desc\s*,\s*recorded_at desc limit \$0$/,
  },
  {
    label: "dashboard.productIngredients",
    source: "src/server/repositories/dashboard.repository.ts:48-58",
    pattern:
      /^select .+ from product_ingredients where\s*\(?\s*tenant_id = \$0 and product_id\s*=?\s*(?:in|any)\s*\(\s*\$0(?:\s*,\s*\$0)*\s*\)\s*\)?$/,
  },
];

/** Rótulo do alvo crítico que a query satisfaz, ou `null`. */
export function classifyCriticalQuery(sql: string): string | null {
  const normalized = normalizeQuery(sql);
  return CRITICAL_QUERIES.find((target) => target.pattern.test(normalized))?.label ?? null;
}

export function parseTopN(argv: readonly string[], fallback = DEFAULT_TOP_N): number {
  const prefix = "--top=";
  const argument = argv.find((value) => value.startsWith(prefix));
  if (!argument) return Math.min(fallback, MAX_TOP_N);
  const parsed = Number(argument.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--top exige um inteiro positivo");
  }
  return Math.min(parsed, MAX_TOP_N);
}

/**
 * Guarda local-only. Valida o host que o **driver** usa (`pg-connection-string`
 * resolve `?host=` por cima da URL) e recusa overrides que fogem do loopback —
 * falha fechado e nunca ecoa a connection string.
 */
export function resolveLocalTarget(env: Record<string, string | undefined>): {
  connectionString: string;
  host: string;
  database: string;
} {
  if (env.NODE_ENV === "production") {
    throw new Error("pg-stat-statements é local-only: NODE_ENV=production recusado");
  }
  const connectionString = env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL é obrigatória");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_ADMIN_URL malformada (fail-closed; valor omitido)");
  }
  if (/(?:^|[?&])hostaddr=/i.test(connectionString)) {
    throw new Error(
      "pg-stat-statements recusa hostaddr na connection string (fail-closed; valor omitido)",
    );
  }
  const hosts = (parseConnectionString(connectionString).host ?? "")
    .split(",")
    .map((host) => host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase())
    .filter((host) => host.length > 0);
  if (hosts.length === 0 || hosts.some((host) => LOCAL_HOSTNAMES[host] !== true)) {
    throw new Error("pg-stat-statements recusa host não-loopback (fail-closed; valor omitido)");
  }
  const database = parsed.pathname.replace(/^\//, "") || "unknown";
  return { connectionString, host: hosts.join(","), database };
}

/** Coerção defensiva: `pg` entrega bigint como string. */
function toStatRow(raw: Record<string, unknown>): StatRow {
  return {
    query: String(raw.query ?? ""),
    calls: Number(raw.calls ?? 0),
    total_exec_time: Number(raw.total_exec_time ?? 0),
    mean_exec_time: Number(raw.mean_exec_time ?? 0),
    rows: Number(raw.rows ?? 0),
  };
}

function toReportRow(row: StatRow): ReportRow {
  return {
    critical: classifyCriticalQuery(row.query),
    operation: normalizeSqlOperation(row.query),
    calls: row.calls,
    total_exec_time: row.total_exec_time,
    mean_exec_time: row.mean_exec_time,
    rows: row.rows,
    statements: 1,
    redacted_query: redactSqlText(row.query, STATS_REDACTION_MAX_LENGTH),
  };
}

function meanOf(total: number, calls: number): number {
  return calls > 0 ? total / calls : 0;
}

function aggregateCritical(target: CriticalTarget, shapes: readonly ReportRow[]): CriticalReport {
  const calls = shapes.reduce((sum, row) => sum + row.calls, 0);
  const total = shapes.reduce((sum, row) => sum + row.total_exec_time, 0);
  return {
    label: target.label,
    source: target.source,
    calls,
    total_exec_time: total,
    mean_exec_time: meanOf(total, calls),
    rows: shapes.reduce((sum, row) => sum + row.rows, 0),
    statements: shapes.reduce((sum, row) => sum + row.statements, 0),
    shapes: shapes.map((row) => row.redacted_query),
  };
}

/**
 * Redige, classifica, **agrega por texto redigido** (mesma query em papéis ou
 * com `in (...)` de tamanhos diferentes vira uma linha só, com a soma de
 * `calls`/`total_exec_time`/`rows` e `mean = total / calls`) e corta o top-N.
 */
export function buildReport(rows: readonly StatRow[], topN: number): Report {
  const byShape = new Map<string, ReportRow>();
  for (const row of rows) {
    const shape = toReportRow(row);
    const existing = byShape.get(shape.redacted_query);
    if (!existing) {
      byShape.set(shape.redacted_query, shape);
      continue;
    }
    existing.calls += shape.calls;
    existing.total_exec_time += shape.total_exec_time;
    existing.rows += shape.rows;
    existing.statements += 1;
    existing.mean_exec_time = meanOf(existing.total_exec_time, existing.calls);
  }
  const aggregated = [...byShape.values()];
  const top = [...aggregated]
    .sort(
      (a, b) =>
        b.total_exec_time - a.total_exec_time ||
        b.calls - a.calls ||
        a.redacted_query.localeCompare(b.redacted_query),
    )
    .slice(0, Math.min(topN, MAX_TOP_N));
  const critical = CRITICAL_QUERIES.flatMap((target) => {
    const shapes = aggregated.filter((row) => row.critical === target.label);
    return shapes.length === 0 ? [] : [aggregateCritical(target, shapes)];
  });
  const observed = new Set(critical.map((entry) => entry.label));
  return {
    patterns: aggregated.length,
    top,
    critical,
    missingCritical: CRITICAL_QUERIES.filter((target) => !observed.has(target.label)).map(
      (target) => target.label,
    ),
  };
}

/**
 * Payload do JSON versionado. Não existe campo com SQL cru: cada linha carrega
 * apenas `redacted_query`, então nada vaza por serialização.
 */
export function buildArtifact(meta: ArtifactMeta): Record<string, unknown> {
  return {
    check: "obs:pg-stat-statements",
    read_only: true,
    regime: REGIME,
    generated_at: meta.generatedAt,
    environment: {
      host: meta.host,
      database: meta.database,
      local_only: true,
      top_n: meta.topN,
    },
    statement_entries: meta.statementEntries,
    patterns: meta.report.patterns,
    missing_critical: meta.report.missingCritical,
    critical: meta.report.critical,
    top: meta.report.top,
  };
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

function criticalTable(rows: readonly CriticalReport[]): string {
  if (rows.length === 0) return "(nenhuma)";
  return renderTable(
    ["critical", "statements", "calls", "total_exec_time_ms", "mean_exec_time_ms", "rows"],
    rows.map((row) => [
      row.label,
      String(row.statements),
      String(row.calls),
      row.total_exec_time.toFixed(3),
      row.mean_exec_time.toFixed(3),
      String(row.rows),
    ]),
  );
}

function topTable(rows: readonly ReportRow[]): string {
  if (rows.length === 0) return "(nenhuma)";
  return renderTable(
    [
      "critical",
      "operation",
      "statements",
      "calls",
      "total_exec_time_ms",
      "mean_exec_time_ms",
      "rows",
    ],
    rows.map((row) => [
      row.critical ?? "-",
      row.operation,
      String(row.statements),
      String(row.calls),
      row.total_exec_time.toFixed(3),
      row.mean_exec_time.toFixed(3),
      String(row.rows),
    ]),
  );
}

function shapesTable(report: Report): string {
  const pairs = [
    ...report.critical.flatMap((entry) =>
      entry.shapes.map((shape) => [entry.label, shape] as [string, string]),
    ),
    ...report.top
      .filter((row) => row.critical === null)
      .map((row) => ["-", row.redacted_query] as [string, string]),
  ];
  if (pairs.length === 0) return "(nenhuma)";
  return renderTable(["critical", "query (redigida)"], pairs);
}

export function renderMarkdown(meta: ArtifactMeta): string {
  const { report } = meta;
  return `# pg_stat_statements — queries críticas (§16.3)

Coletor local: \`scripts/obs/pg-stat-statements.ts\`. Regime: **${REGIME}** (host loopback, dataset sintético de teste) — **nunca** \`OBSERVED\`.

- Gerado em: ${meta.generatedAt}
- Host: ${meta.host} (loopback)
- Banco: ${meta.database}
- Entradas de \`pg_stat_statements\` observadas: ${meta.statementEntries}
- Padrões distintos após agregação: ${report.patterns}
- Top-N exibido: ${meta.topN}

## Queries críticas do §16.4 encontradas

${criticalTable(report.critical)}

Alvos não observados: ${report.missingCritical.length ? report.missingCritical.join(", ") : "(nenhum)"}

## Formas observadas (parâmetros redigidos)

${shapesTable(report)}

## Top-${meta.topN} por \`total_exec_time\`

${topTable(report.top)}
`;
}

function describeMissingExtension(error: unknown): string | undefined {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42P01") {
    return "extensão pg_stat_statements ausente: rode em ambiente com shared_preload_libraries=pg_stat_statements + CREATE EXTENSION (container efêmero de medição)";
  }
  return undefined;
}

async function readStatements(client: Client): Promise<StatRow[]> {
  try {
    const result = await client.query<Record<string, unknown>>(STATEMENTS_SQL);
    return result.rows.map(toStatRow);
  } catch (error) {
    const hint = describeMissingExtension(error);
    if (hint) throw new Error(hint);
    throw error;
  }
}

async function main(): Promise<void> {
  const { connectionString, host, database } = resolveLocalTarget(process.env);
  const topN = parseTopN(process.argv.slice(2));

  const client = new Client({ connectionString });
  await client.connect();
  let rows: StatRow[];
  try {
    rows = await readStatements(client);
  } finally {
    await client.end().catch(() => undefined);
  }

  const report = buildReport(rows, topN);
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const outputDirectory = resolve(process.cwd(), EVIDENCE_DIR);
  await mkdir(outputDirectory, { recursive: true });

  const meta: ArtifactMeta = {
    generatedAt,
    host,
    database,
    topN,
    statementEntries: rows.length,
    report,
  };
  const jsonPath = resolve(outputDirectory, `pg-stat-statements-${stamp}.json`);
  const markdownPath = resolve(outputDirectory, `pg-stat-statements-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(buildArtifact(meta), null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdown(meta));

  console.log(
    `pg-stat-statements: ${rows.length} entradas · ${report.patterns} padrões · ${report.critical.length}/${CRITICAL_QUERIES.length} queries críticas observadas (regime ${REGIME})`,
  );
  for (const row of report.critical) {
    console.log(
      `pg-stat-statements: ${row.label} statements=${row.statements} calls=${row.calls} total=${row.total_exec_time.toFixed(3)}ms mean=${row.mean_exec_time.toFixed(3)}ms rows=${row.rows}`,
    );
  }
  if (report.missingCritical.length) {
    console.log(`pg-stat-statements: alvos ausentes: ${report.missingCritical.join(", ")}`);
  }
  console.log(`pg-stat-statements: ${jsonPath}`);
  console.log(`pg-stat-statements: ${markdownPath}`);
}

// Guarda de entrypoint (padrão canônico do repositório, ver error-budget.ts):
// importar este módulo (teste) nunca abre conexão com o banco.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(`pg-stat-statements: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
