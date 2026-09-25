/**
 * Amostrador local de saturação do pool (§16.7): lê `pg_stat_activity` a cada
 * ~250 ms e grava JSON+MD em `docs/evidence/pool-saturation-2026-09-13/`.
 *
 * Local-only por contrato: recusa `NODE_ENV=production` e host que não seja
 * loopback (127.0.0.1/localhost/::1), espelhando `scripts/env-guard.mjs`.
 * Nunca imprime nem grava a URL de conexão.
 *
 * Uso:
 *   DATABASE_ADMIN_URL=... DATABASE_DRIVER=node-postgres \
 *     npx tsx scripts/obs/pool-activity.ts [--duration-ms=5000] [--interval-ms=250]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const EVIDENCE_DIR = "docs/evidence/pool-saturation-2026-09-13";
const DEFAULT_DURATION_MS = 5_000;
const DEFAULT_INTERVAL_MS = 250;
const MAX_DURATION_MS = 60_000;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 5_000;
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

interface ActivityRow {
  state: string;
  wait_event_type: string;
  wait_event: string;
  count: number;
}

interface Sample {
  elapsed_ms: number;
  total: number;
  active: number;
  idle: number;
  idle_in_transaction: number;
  waiting: number;
  states: Record<string, number>;
  wait_events: Record<string, number>;
}

function parsePositiveIntArg(argv: string[], name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  if (!argument) return fallback;
  const parsed = Number(argument.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} exige um inteiro positivo`);
  }
  return parsed;
}

function assertLocalOnly(): { connectionString: string; host: string; database: string } {
  if (process.env.NODE_ENV === "production") {
    throw new Error("pool-activity é local-only: NODE_ENV=production recusado");
  }
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL é obrigatória");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_ADMIN_URL malformada (fail-closed; valor omitido)");
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!LOCAL_HOSTNAMES.has(host)) {
    throw new Error("pool-activity recusa host não-loopback (fail-closed; valor omitido)");
  }
  const database = parsed.pathname.replace(/^\//, "") || "unknown";
  return { connectionString, host, database };
}

async function readMaxConnections(client: Client): Promise<number | undefined> {
  const result = await client.query<{ max_connections: number }>(
    "select current_setting('max_connections')::int as max_connections",
  );
  return result.rows[0]?.max_connections;
}

async function sampleOnce(client: Client, startedAt: number): Promise<Sample> {
  const result = await client.query<ActivityRow>(`
    select
      coalesce(state, 'unknown') as state,
      coalesce(wait_event_type, 'none') as wait_event_type,
      coalesce(wait_event, 'none') as wait_event,
      count(*)::int as count
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
    group by 1, 2, 3
    order by count desc
  `);
  const states: Record<string, number> = {};
  const waitEvents: Record<string, number> = {};
  let total = 0;
  let active = 0;
  let idle = 0;
  let idleInTransaction = 0;
  let waiting = 0;
  for (const row of result.rows) {
    const count = Number(row.count) || 0;
    total += count;
    states[row.state] = (states[row.state] ?? 0) + count;
    if (row.wait_event_type !== "none") {
      const key = `${row.wait_event_type}/${row.wait_event}`;
      waitEvents[key] = (waitEvents[key] ?? 0) + count;
      if (row.wait_event_type !== "Client" && row.wait_event_type !== "Activity") {
        waiting += count;
      }
    }
    if (row.state === "active") active += count;
    if (row.state === "idle") idle += count;
    if (row.state === "idle in transaction") idleInTransaction += count;
  }
  return {
    elapsed_ms: Math.round(performance.now() - startedAt),
    total,
    active,
    idle,
    idle_in_transaction: idleInTransaction,
    waiting,
    states,
    wait_events: waitEvents,
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

function renderMarkdown(meta: {
  generatedAt: string;
  host: string;
  database: string;
  driver: string;
  durationMs: number;
  intervalMs: number;
  maxConnections?: number;
  samples: Sample[];
}): string {
  const timeline = renderTable(
    ["elapsed_ms", "total", "active", "idle", "idle_in_transaction", "waiting"],
    meta.samples.map((sample) => [
      String(sample.elapsed_ms),
      String(sample.total),
      String(sample.active),
      String(sample.idle),
      String(sample.idle_in_transaction),
      String(sample.waiting),
    ]),
  );
  const waitEvents = new Map<string, number>();
  for (const sample of meta.samples) {
    for (const [event, count] of Object.entries(sample.wait_events)) {
      waitEvents.set(event, (waitEvents.get(event) ?? 0) + count);
    }
  }
  const waitRows = [...waitEvents.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([event, count]) => [event, String(count)]);
  const waitTable = renderTable(
    ["wait_event", "count"],
    waitRows.length ? waitRows : [["(nenhum)", "0"]],
  );
  return `# Pool activity — pg_stat_activity (${meta.generatedAt.slice(0, 10)})

Amostra local de saturação do Postgres (§16.7). Script: \`scripts/obs/pool-activity.ts\`.

- Gerado em: ${meta.generatedAt}
- Host: ${meta.host} (loopback)
- Banco: ${meta.database}
- Driver: ${meta.driver}
- Janela: ${meta.durationMs} ms · intervalo: ${meta.intervalMs} ms · amostras: ${meta.samples.length}
- max_connections: ${meta.maxConnections ?? "n/d"}

## Série temporal

${timeline}

## Wait events (soma da janela)

${waitTable}
`;
}

async function main(): Promise<void> {
  const { connectionString, host, database } = assertLocalOnly();
  const argv = process.argv.slice(2);
  const durationMs = Math.min(
    parsePositiveIntArg(argv, "duration-ms", DEFAULT_DURATION_MS),
    MAX_DURATION_MS,
  );
  const intervalMs = Math.min(
    Math.max(parsePositiveIntArg(argv, "interval-ms", DEFAULT_INTERVAL_MS), MIN_INTERVAL_MS),
    MAX_INTERVAL_MS,
  );

  const client = new Client({ connectionString });
  await client.connect();
  const startedAt = performance.now();
  const samples: Sample[] = [];
  const maxConnections = await readMaxConnections(client);
  try {
    while (performance.now() - startedAt < durationMs) {
      const tick = performance.now();
      samples.push(await sampleOnce(client, startedAt));
      const remaining = intervalMs - (performance.now() - tick);
      if (remaining > 0) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, remaining));
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const outputDirectory = resolve(process.cwd(), EVIDENCE_DIR);
  await mkdir(outputDirectory, { recursive: true });
  const payload = {
    check: "obs:pool-activity",
    read_only: true,
    generated_at: generatedAt,
    environment: {
      host,
      database,
      driver: process.env.DATABASE_DRIVER ?? "node-postgres",
      local_only: true,
    },
    duration_ms: durationMs,
    interval_ms: intervalMs,
    max_connections: maxConnections,
    samples,
  };
  const jsonPath = resolve(outputDirectory, `pool-activity-${stamp}.json`);
  const markdownPath = resolve(outputDirectory, `pool-activity-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(
    markdownPath,
    renderMarkdown({
      generatedAt,
      host,
      database,
      driver: payload.environment.driver,
      durationMs,
      intervalMs,
      maxConnections,
      samples,
    }),
  );
  console.log(`pool-activity: ${samples.length} amostras em ${durationMs} ms`);
  console.log(`pool-activity: ${jsonPath}`);
  console.log(`pool-activity: ${markdownPath}`);
}

main().catch((error: unknown) => {
  console.error(`pool-activity: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
