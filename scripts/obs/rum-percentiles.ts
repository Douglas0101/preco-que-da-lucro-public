/**
 * §17.8 — p75 dos Web Vitals persistidos em `rum_vitals`.
 *
 * Lê a série via `DATABASE_ADMIN_URL` (local-only: recusa qualquer host que não
 * seja loopback), agrega `percentile_cont(0.75)` por métrica/janela e grava o
 * relatório + JSON bruto em `docs/evidence/rum-p75-<data>/`.
 *
 * Uso: `npx tsx scripts/obs/rum-percentiles.ts [--window=7 days] [--date=YYYY-MM-DD] [--out=<dir>]`
 * Exit 0 = relatório gerado; exit 2 = uso/DB inválido (nunca conecta fora do loopback).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { format } from "prettier";

/** Alvos Core Web Vitals (p75): LCP em ms, INP em ms, CLS unitless. */
const TARGETS: Readonly<Record<string, { target: number; unit: string; label: string }>> = {
  LCP: { target: 2_500, unit: "ms", label: "LCP ≤ 2,5 s" },
  INP: { target: 200, unit: "ms", label: "INP ≤ 200 ms" },
  CLS: { target: 0.1, unit: "", label: "CLS ≤ 0,1" },
};

/** Abaixo deste N a métrica é reportada como N/A (amostra insuficiente). */
const MIN_SAMPLES = 20;

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

interface Args {
  window: string;
  date: string;
  outDir: string;
}

interface PercentileRow {
  name: string;
  n: number;
  p75: number;
  window_start: Date;
  window_end: Date;
}

export function parseArgs(argv: readonly string[]): Args {
  let date = new Date().toISOString().slice(0, 10);
  let dateExplicit: string | undefined;
  let window = "7 days";
  let outDir: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--window=")) {
      window = arg.slice("--window=".length).trim();
      if (window === "") throw new Error("--window não pode ser vazio");
    } else if (arg.startsWith("--date=")) {
      const value = arg.slice("--date=".length).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--date deve ser YYYY-MM-DD");
      dateExplicit = value;
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length).trim();
    } else {
      throw new Error(`argumento desconhecido: ${arg}`);
    }
  }
  date = dateExplicit ?? date;
  return {
    window,
    date,
    outDir: outDir ?? `docs/evidence/rum-p75-${date}`,
  };
}

/** Fail-closed: a agregação só roda contra o banco local de laboratório. */
export function requireLocalAdminUrl(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_ADMIN_URL é obrigatória (local-only)");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_ADMIN_URL malformada");
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!LOCAL_HOSTNAMES.has(host)) {
    throw new Error(`rum-percentiles é local-only; host recusado: ${host}`);
  }
  return raw;
}

export function verdictFor(row: PercentileRow): string {
  const target = TARGETS[row.name];
  if (!target) return "sem target declarado";
  if (row.n < MIN_SAMPLES) return `N/A (N=${row.n} < ${MIN_SAMPLES})`;
  return row.p75 <= target.target ? "OK" : "REGRESSÃO";
}

export function renderReport(rows: readonly PercentileRow[], args: Args): string {
  const lines = [
    `# RUM p75 — ${args.date}`,
    "",
    `- Fonte: \`rum_vitals\` (migration 0014), série persistida do endpoint \`/api/vitals\`.`,
    `- Janela: \`${args.window}\` (received_at >= now() - interval).`,
    `- Mínimo de amostras por métrica: ${MIN_SAMPLES} (abaixo disso: N/A).`,
    `- Alvos p75: LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1.`,
    "- Gerado por: `npx tsx scripts/obs/rum-percentiles.ts`",
    "",
  ];

  if (rows.length === 0) {
    lines.push("Nenhuma amostra em `rum_vitals` na janela declarada — todas as métricas N/A.", "");
  } else {
    lines.push("| Métrica | N | p75 | Alvo | Veredito |", "| --- | ---: | ---: | --- | --- |");
    for (const row of rows) {
      const target = TARGETS[row.name];
      const p75 = target
        ? `${row.p75.toFixed(target.unit === "" ? 3 : 0)} ${target.unit}`.trim()
        : String(row.p75);
      lines.push(
        `| ${row.name} | ${row.n} | ${p75} | ${target ? target.label : "—"} | ${verdictFor(row)} |`,
      );
    }
    const missing = Object.keys(TARGETS).filter((name) => !rows.some((row) => row.name === name));
    if (missing.length > 0) {
      lines.push(
        "",
        `Sem amostras na janela para: ${missing.join(", ")} — N/A por ausência de dados.`,
      );
    }
    lines.push("");
    lines.push("## Janela observada", "");
    for (const row of rows) {
      lines.push(
        `- ${row.name}: ${row.window_start.toISOString()} → ${row.window_end.toISOString()}`,
      );
    }
  }

  lines.push(
    "",
    "## Privacidade e retenção",
    "",
    "- Sem PII: apenas nome da métrica, valor, rating, delta e navigation type.",
    "- Sem tenant_id/RLS: métrica global de performance do browser; o runtime é INSERT-only e a leitura é admin/local.",
    "- Retenção: série descartável de telemetria; o down da 0014 (`DROP TABLE`) é o caminho de limpeza.",
    "",
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const adminUrl = requireLocalAdminUrl(process.env.DATABASE_ADMIN_URL);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  let rows: PercentileRow[];
  try {
    const result = await client.query<PercentileRow>(
      `select name,
              count(*)::integer as n,
              percentile_cont(0.75) within group (order by value) as p75,
              min(received_at) as window_start,
              max(received_at) as window_end
         from rum_vitals
        where received_at >= now() - $1::interval
        group by name
        order by name`,
      [args.window],
    );
    rows = result.rows;
  } finally {
    await client.end();
  }

  const outDir = resolve(args.outDir);
  await mkdir(outDir, { recursive: true });
  const raw = {
    generated_at: new Date().toISOString(),
    window: args.window,
    min_samples: MIN_SAMPLES,
    targets: TARGETS,
    rows: rows.map((row) => ({
      name: row.name,
      n: row.n,
      p75: row.p75,
      window_start: row.window_start.toISOString(),
      window_end: row.window_end.toISOString(),
      verdict: verdictFor(row),
    })),
  };
  await writeFile(resolve(outDir, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const report = await format(renderReport(rows, args), { parser: "markdown" });
  await writeFile(resolve(outDir, "report.md"), report, "utf8");
  console.log(`RUM p75 (${args.window}): ${rows.length} métrica(s) → ${args.outDir}`);
}

// Guarda de entrypoint: só roda main() quando este arquivo é executado direto,
// para que importá-lo (testes, reuso do pipeline de p75) não abra conexão com o
// banco. Usa `pathToFileURL` — o padrão canônico do repositório
// (ver m02-secrets-audit.ts) — porque uma URL `file://` montada à mão quebra em
// paths com caracteres significativos para URL (ex.: '#' ou '?').
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
