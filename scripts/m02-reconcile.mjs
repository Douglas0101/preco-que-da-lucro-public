// m02-reconcile.mjs — reconciliação de dados read-only entre dois bancos
// PostgreSQL (norma M-02, plano mestre §13.4/§13.5). Reutilizável no V2
// (dry-run production × branch de drill), no V4 e no T+ do cutover.
//
// Contrato:
//   node scripts/m02-reconcile.mjs --source-env <ENV> --target-env <ENV> --out <caminho.md>
//   - URLs de conexão vêm SEMPRE das variáveis de ambiente indicadas pelos
//     NOMES passados em argv (nunca valores em argv, nunca impressos).
//   - Apenas SELECT: toda sessão abre `start transaction read only` e faz
//     rollback ao fim. Nenhuma escrita é emitida.
//   - SQL de valores sempre parametrizado; identificadores via quote().
//   - Erros de banco são suprimidos para forma genérica (código/severidade),
//     sem mensagem que possa conter host/credencial.
//   - Saída: Markdown §13.5 + JSON companheiro ao lado do .md.
// Exit codes: 0 = pass (todas differences 0 e status OK) · 1 = pass false
// (diferenças registradas no relatório) · 2 = erro de ambiente (fail-closed).

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const FINANCIAL_NAME = /(amount|price|total|cost|fee|tax|salary|value)/i;
const FINANCIAL_TYPES = new Set(["numeric", "integer", "bigint", "smallint", "money"]);
const TIMESTAMP_TYPES = new Set([
  "timestamp without time zone",
  "timestamp with time zone",
  "date",
]);
const SAMPLE_LIMIT = 100;

function usage() {
  return [
    "uso: node scripts/m02-reconcile.mjs \\",
    "  --source-env <NOME_DA_ENV> --target-env <NOME_DA_ENV> --out <caminho.md>",
    "As URLs são lidas das variáveis de ambiente indicadas (valores nunca impressos).",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { sourceEnv: undefined, targetEnv: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      const inline = arg.slice(name.length + 3);
      if (arg.startsWith(`--${name}=`)) return inline;
      if (arg === `--${name}`) {
        index += 1;
        return argv[index];
      }
      return undefined;
    };
    if (arg.startsWith("--source-env")) {
      parsed.sourceEnv = take("source-env");
    } else if (arg.startsWith("--target-env")) {
      parsed.targetEnv = take("target-env");
    } else if (arg.startsWith("--out")) {
      parsed.out = take("out");
    } else {
      return { error: `argumento não reconhecido: ${arg}` };
    }
  }
  for (const key of ["sourceEnv", "targetEnv", "out"]) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      const optionName = key.endsWith("Env") ? `${key.slice(0, -3)}-env` : key;
      return { error: `--${optionName} é obrigatório` };
    }
  }
  if (!/\.md$/.test(parsed.out)) {
    return { error: "--out deve apontar para um arquivo .md" };
  }
  return parsed;
}

/** Helper de identificador seguro: escapa aspas duplas e envolve em ". */
function quote(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function qualified(schema, table) {
  return `${quote(schema)}.${quote(table)}`;
}

/** Nunca ecoar algo que possa conter URL/credencial. */
function dbErrorSummary(error) {
  return {
    code: error?.code ?? "DESCONHECIDO",
    severity: error?.severity ?? null,
    message: "detalhes omitidos (norma: nenhum valor de URL/credencial impresso)",
  };
}

function envUrl(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

function isLocalUrl(url) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname.replace(/^\[/, "").replace(/\]$/, ""));
  } catch {
    return false;
  }
}

function makePool(url) {
  return new Pool({
    connectionString: url,
    max: 2,
    ssl: isLocalUrl(url) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
  });
}

/**
 * Abre um client com transação READ ONLY e devolve { query, close }.
 * Rollback garante que nenhuma mutação escape mesmo em caso de erro.
 */
async function readOnlySession(pool) {
  const client = await pool.connect();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.query("rollback");
    } catch {
      // sessão já encerrada; nada a fazer
    }
    client.release();
    await pool.end();
  };
  try {
    await client.query("start transaction read only");
    await client.query("set local time zone 'UTC'");
  } catch (error) {
    await close();
    throw error;
  }
  const query = (text, params = []) => client.query(text, params);
  return { query, close };
}

async function listPublicTables(session) {
  const result = await session.query(
    `select schemaname, tablename
     from pg_tables
     where schemaname = 'public'
     order by tablename`,
  );
  return result.rows.map((row) => row.tablename);
}

async function listColumns(session, table) {
  const result = await session.query(
    `select column_name, data_type
     from information_schema.columns
     where table_schema = 'public' and table_name = $1
     order by ordinal_position`,
    [table],
  );
  return result.rows.map((row) => ({ name: row.column_name, type: row.data_type }));
}

async function listPrimaryKeys(session, table) {
  const result = await session.query(
    `select a.attname as column_name, k.ord
     from pg_index i
     join unnest(i.indkey) with ordinality as k(attnum, ord) on true
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indrelid = to_regclass(format('public.%I', $1::text))
       and i.indisprimary
     order by k.ord`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function listForeignKeys(session, table) {
  const result = await session.query(
    `select con.conname as constraint_name,
            src.relname as child_table,
            tgt.relname as parent_table,
            jsonb_agg(
              jsonb_build_object('child_column', att.attname, 'parent_column', tatt.attname)
              order by ck.ord
            ) as pairs
     from pg_constraint con
     join pg_class src on src.oid = con.conrelid
     join pg_namespace ns on ns.oid = src.relnamespace
     join pg_class tgt on tgt.oid = con.confrelid
     join unnest(con.conkey) with ordinality as ck(attnum, ord) on true
     join unnest(con.confkey) with ordinality as fk(attnum, ord) on fk.ord = ck.ord
     join pg_attribute att on att.attrelid = src.oid and att.attnum = ck.attnum
     join pg_attribute tatt on tatt.attrelid = tgt.oid and tatt.attnum = fk.attnum
     where con.contype = 'f'
       and ns.nspname = 'public'
       and src.relname = $1
     group by con.conname, src.relname, tgt.relname
     order by con.conname`,
    [table],
  );
  return result.rows.map((row) => ({
    constraint: row.constraint_name,
    childTable: row.child_table,
    parentTable: row.parent_table,
    pairs: row.pairs,
  }));
}

async function rowCount(session, table) {
  const result = await session.query(
    `select count(*)::bigint as n from ${qualified("public", table)}`,
  );
  return Number(result.rows[0].n);
}

async function nullCounts(session, table, columns) {
  if (columns.length === 0) return {};
  const selects = columns
    .map((column) => `count(*) filter (where ${quote(column)} is null) as ${quote(column)}`)
    .join(", ");
  const result = await session.query(`select ${selects} from ${qualified("public", table)}`);
  const counts = {};
  for (const column of columns) counts[column] = Number(result.rows[0][column]);
  return counts;
}

async function timestampBounds(session, table, columns) {
  if (columns.length === 0) return {};
  const selects = columns
    .map((column) => [
      `min(${quote(column)})::text as ${quote(`${column}__min`)}`,
      `max(${quote(column)})::text as ${quote(`${column}__max`)}`,
    ])
    .flat()
    .join(", ");
  const result = await session.query(`select ${selects} from ${qualified("public", table)}`);
  const bounds = {};
  for (const column of columns) {
    bounds[column] = {
      min: result.rows[0][`${column}__min`],
      max: result.rows[0][`${column}__max`],
    };
  }
  return bounds;
}

async function financialSums(session, table, columns) {
  if (columns.length === 0) return {};
  const selects = columns
    .map((column) => `sum(${quote(column)})::text as ${quote(column)}`)
    .join(", ");
  const result = await session.query(`select ${selects} from ${qualified("public", table)}`);
  const sums = {};
  for (const column of columns) sums[column] = result.rows[0][column];
  return sums;
}

async function orphanCounts(session, table, foreignKeys) {
  const orphans = [];
  for (const fk of foreignKeys) {
    const childWhere = fk.pairs
      .map((pair) => `${quote(pair.child_column)} is not null`)
      .join(" and ");
    const parentMatch = fk.pairs
      .map((pair) => `p.${quote(pair.parent_column)} = c.${quote(pair.child_column)}`)
      .join(" and ");
    const result = await session.query(
      `select count(*)::bigint as n
       from ${qualified("public", fk.childTable)} c
       where ${childWhere}
         and not exists (
           select 1 from ${qualified("public", fk.parentTable)} p
           where ${parentMatch}
         )`,
    );
    orphans.push({
      constraint: fk.constraint,
      child_table: fk.childTable,
      parent_table: fk.parentTable,
      columns: fk.pairs,
      count: Number(result.rows[0].n),
    });
  }
  return orphans;
}

async function sampleChecksum(session, table, primaryKeys) {
  if (primaryKeys.length === 0) {
    return { algorithm: "sha256", rows: null, checksum: null, note: "sem PK — checksum omitido" };
  }
  const order = primaryKeys.map((column) => quote(column)).join(", ");
  const result = await session.query(
    `select to_jsonb(t)::text as row_text
     from (
       select * from ${qualified("public", table)}
       order by ${order}
       limit ($1)::int
     ) t`,
    [SAMPLE_LIMIT],
  );
  const hash = createHash("sha256");
  for (const row of result.rows) hash.update(row.row_text);
  return {
    algorithm: "sha256",
    rows: result.rows.length,
    checksum: hash.digest("hex"),
    note: null,
  };
}

async function collectSide(session, tables) {
  const perTable = {};
  for (const table of tables) {
    const columns = await listColumns(session, table);
    const columnNames = columns.map((column) => column.name);
    const timestampColumns = columns
      .filter(
        (column) =>
          TIMESTAMP_TYPES.has(column.type) && /(^|_)(created_at|updated_at)$/.test(column.name),
      )
      .map((column) => column.name);
    const financialColumns = columns
      .filter((column) => FINANCIAL_NAME.test(column.name) && FINANCIAL_TYPES.has(column.type))
      .map((column) => column.name);
    const primaryKeys = await listPrimaryKeys(session, table);
    const foreignKeys = await listForeignKeys(session, table);

    perTable[table] = {
      columns: columnNames,
      rowCount: await rowCount(session, table),
      nullCounts: await nullCounts(session, table, columnNames),
      timestampBounds: await timestampBounds(session, table, timestampColumns),
      financialSums: await financialSums(session, table, financialColumns),
      primaryKeys,
      foreignKeys: foreignKeys.map((fk) => ({
        constraint: fk.constraint,
        child_table: fk.childTable,
        parent_table: fk.parentTable,
        columns: fk.pairs,
      })),
      orphanCounts: await orphanCounts(session, table, foreignKeys),
      sampleChecksum: await sampleChecksum(session, table, primaryKeys),
    };
  }
  return perTable;
}

function equalOrNull(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return String(a) === String(b);
}

function compareMetricMaps(sourceMap, targetMap) {
  const keys = Array.from(new Set([...Object.keys(sourceMap), ...Object.keys(targetMap)])).sort(
    (a, b) => a.localeCompare(b),
  );
  return keys.map((key) => ({
    key,
    source: sourceMap[key] ?? null,
    target: targetMap[key] ?? null,
    equal: equalOrNull(sourceMap[key], targetMap[key]),
  }));
}

function compareBounds(sourceMap, targetMap) {
  const keys = Array.from(new Set([...Object.keys(sourceMap), ...Object.keys(targetMap)])).sort(
    (a, b) => a.localeCompare(b),
  );
  return keys.map((key) => ({
    key,
    source: sourceMap[key] ?? { min: null, max: null },
    target: targetMap[key] ?? { min: null, max: null },
    equal:
      equalOrNull(sourceMap[key]?.min, targetMap[key]?.min) &&
      equalOrNull(sourceMap[key]?.max, targetMap[key]?.max),
  }));
}

function compareOrphans(sourceOrphans, targetOrphans) {
  const byKey = (orphan) => `${orphan.constraint}|${orphan.child_table}|${orphan.parent_table}`;
  const map = new Map();
  for (const orphan of sourceOrphans) {
    map.set(byKey(orphan), { ...orphan, source: orphan.count, target: null, equal: null });
  }
  for (const orphan of targetOrphans) {
    const key = byKey(orphan);
    const existing = map.get(key);
    if (existing) {
      existing.target = orphan.count;
      existing.equal = existing.source === orphan.count;
    } else {
      map.set(key, { ...orphan, source: null, target: orphan.count, equal: null });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.constraint.localeCompare(b.constraint));
}

function reconcileTables(sourceData, targetData, sourceTables, targetTables) {
  const allTables = Array.from(new Set([...sourceTables, ...targetTables])).sort((a, b) =>
    a.localeCompare(b),
  );
  return allTables.map((table) => {
    const inSource = sourceTables.includes(table);
    const inTarget = targetTables.includes(table);
    const source = inSource ? sourceData[table] : null;
    const target = inTarget ? targetData[table] : null;

    if (!inSource || !inTarget) {
      return {
        table,
        source_count: inSource ? source.rowCount : null,
        target_count: inTarget ? target.rowCount : null,
        difference: null,
        status: inSource ? "MISSING_IN_TARGET" : "MISSING_IN_SOURCE",
        details: { presence: { source: inSource, target: inTarget } },
      };
    }

    const nullComparison = compareMetricMaps(source.nullCounts, target.nullCounts);
    const sumComparison = compareMetricMaps(source.financialSums, target.financialSums);
    const boundsComparison = compareBounds(source.timestampBounds, target.timestampBounds);
    const orphanComparison = compareOrphans(source.orphanCounts, target.orphanCounts);
    const checksumEqual = equalOrNull(
      source.sampleChecksum.checksum,
      target.sampleChecksum.checksum,
    );

    const difference = source.rowCount - target.rowCount;
    const metricsEqual =
      nullComparison.every((item) => item.equal) &&
      sumComparison.every((item) => item.equal) &&
      boundsComparison.every((item) => item.equal) &&
      orphanComparison.every((item) => item.equal !== false) &&
      checksumEqual;
    const status = difference === 0 && metricsEqual ? "OK" : "DIFF";

    return {
      table,
      source_count: source.rowCount,
      target_count: target.rowCount,
      difference,
      status,
      details: {
        null_counts: nullComparison,
        financial_sums: sumComparison,
        timestamp_bounds: boundsComparison,
        orphans: orphanComparison,
        sample_checksum: {
          source: source.sampleChecksum,
          target: target.sampleChecksum,
          equal: checksumEqual,
        },
        primary_keys: { source: source.primaryKeys, target: target.primaryKeys },
      },
    };
  });
}

function renderHeader(report) {
  return [
    `# Reconciliação M-02 (§13.4/§13.5) — ${report.meta.label}`,
    "",
    `- gerado_em: ${report.meta.generated_at}`,
    `- source_env: \`${report.meta.source_env}\` (valor da URL omitido por norma)`,
    `- target_env: \`${report.meta.target_env}\` (valor da URL omitido por norma)`,
    "- modo: somente leitura (`start transaction read only` + rollback; apenas SELECT)",
    "- métricas por tabela (§13.4): row count; null count por coluna; min/max de timestamps " +
      "(created_at/updated_at); soma de colunas financeiras; órfãos por FK declarada no target; " +
      `checksum sha256 da amostra (≤${SAMPLE_LIMIT} linhas ordenadas pela PK, to_jsonb(t)::text)`,
    "",
  ];
}

function renderTableSummary(report) {
  const rows = report.tables.map((row) => {
    const difference = row.difference === null ? "N/A" : String(row.difference);
    const sourceCount = row.source_count === null ? "—" : String(row.source_count);
    const targetCount = row.target_count === null ? "—" : String(row.target_count);
    return `| ${row.table} | ${sourceCount} | ${targetCount} | ${difference} | ${row.status} |`;
  });
  return [
    "## Tabela §13.5",
    "",
    "| table | source_count | target_count | difference | status |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows,
    "",
  ];
}

function renderMetricLines(title, items, format) {
  if (items.length === 0) return [];
  return [title, ...items.map(format)];
}

function renderTableDetails(row) {
  const header = [`### ${row.table}`, ""];
  if (row.status === "MISSING_IN_SOURCE" || row.status === "MISSING_IN_TARGET") {
    return [
      ...header,
      `- presença: source=${row.details.presence.source} target=${row.details.presence.target}`,
      "",
    ];
  }
  const nonNullColumns = row.details.null_counts.filter(
    (item) => item.source !== 0 || item.target !== 0,
  );
  const checksum = row.details.sample_checksum;
  return [
    ...header,
    `- row_count: source=${row.source_count} target=${row.target_count}`,
    `- null_counts: ${nonNullColumns.length === 0 ? "nenhum null em coluna comum" : ""}`,
    ...nonNullColumns.map(
      (item) => `  - ${item.key}: source=${item.source} target=${item.target} equal=${item.equal}`,
    ),
    ...renderMetricLines(
      "- timestamp_bounds (min/max, UTC):",
      row.details.timestamp_bounds,
      (item) =>
        `  - ${item.key}: source=[${item.source.min} .. ${item.source.max}] ` +
        `target=[${item.target.min} .. ${item.target.max}] equal=${item.equal}`,
    ),
    ...renderMetricLines(
      "- financial_sums:",
      row.details.financial_sums,
      (item) => `  - ${item.key}: source=${item.source} target=${item.target} equal=${item.equal}`,
    ),
    ...renderMetricLines(
      "- orphans (FKs declaradas no target):",
      row.details.orphans,
      (item) =>
        `  - ${item.constraint} (${item.child_table} → ${item.parent_table}): ` +
        `source=${item.source} target=${item.target} equal=${item.equal}`,
    ),
    `- sample_checksum (${checksum.source.rows ?? 0}/${SAMPLE_LIMIT} linhas, sha256): ` +
      `source=${checksum.source.checksum ?? "omitido"} target=${checksum.target.checksum ?? "omitido"} ` +
      `equal=${checksum.equal}`,
    "",
  ];
}

function renderSummary(report) {
  return [
    "## Sumário",
    "",
    `- tables_compared: ${report.summary.tables_compared}`,
    `- differences_total: ${report.summary.differences_total}`,
    `- pass: ${report.summary.pass}`,
    "",
  ];
}

function renderMarkdown(report) {
  return [
    ...renderHeader(report),
    ...renderTableSummary(report),
    "## Detalhes por tabela",
    "",
    ...report.tables.flatMap(renderTableDetails),
    ...renderSummary(report),
  ].join("\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`m02-reconcile: ${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const sourceUrl = envUrl(parsed.sourceEnv);
  const targetUrl = envUrl(parsed.targetEnv);
  if (!sourceUrl || !targetUrl) {
    process.stderr.write(
      "m02-reconcile: erro de ambiente (fail-closed): variável de conexão ausente " +
        `(source=${parsed.sourceEnv} target=${parsed.targetEnv}; valores nunca impressos)\n`,
    );
    process.exitCode = 2;
    return;
  }
  const sourcePool = makePool(sourceUrl);
  const targetPool = makePool(targetUrl);
  let sourceSession;
  let targetSession;
  try {
    sourceSession = await readOnlySession(sourcePool);
    targetSession = await readOnlySession(targetPool);
    const [sourceTables, targetTables] = await Promise.all([
      listPublicTables(sourceSession),
      listPublicTables(targetSession),
    ]);
    const sourceData = await collectSide(sourceSession, sourceTables);
    const targetData = await collectSide(targetSession, targetTables);
    const rows = reconcileTables(sourceData, targetData, sourceTables, targetTables);

    const tablesCompared = rows.length;
    const differencesTotal = rows.filter(
      (row) => row.difference !== 0 || row.status !== "OK",
    ).length;
    const pass = rows.every((row) => row.difference === 0 && row.status === "OK");

    const report = {
      meta: {
        label: `${parsed.sourceEnv} × ${parsed.targetEnv}`,
        generated_at: new Date().toISOString(),
        source_env: parsed.sourceEnv,
        target_env: parsed.targetEnv,
        read_only: true,
        sample_limit: SAMPLE_LIMIT,
        checksum_algorithm: "sha256(to_jsonb(t)::text) sobre ≤100 linhas ordenadas pela PK",
      },
      tables: rows,
      summary: { tables_compared: tablesCompared, differences_total: differencesTotal, pass },
    };

    const markdown = renderMarkdown(report);
    const outPath = resolve(parsed.out);
    const jsonPath = outPath.replace(/\.md$/, ".json");
    writeFileSync(outPath, markdown);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

    process.stdout.write(
      `${JSON.stringify({
        script: "m02-reconcile",
        source_env: parsed.sourceEnv,
        target_env: parsed.targetEnv,
        out: parsed.out,
        tables_compared: tablesCompared,
        differences_total: differencesTotal,
        pass,
      })}\n`,
    );
    process.exitCode = pass ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `m02-reconcile: erro de conexão/banco (fail-closed): ${JSON.stringify(dbErrorSummary(error))}\n`,
    );
    process.exitCode = 2;
  } finally {
    await sourceSession?.close();
    await targetSession?.close();
  }
}

await main();
