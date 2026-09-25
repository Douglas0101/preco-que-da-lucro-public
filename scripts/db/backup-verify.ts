import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool, type PoolClient } from "pg";

export interface Inventory {
  identity?: { project_id: string; branch_id: string; endpoint_id: string };
  measured_at: string;
  version: string;
  tables: Record<string, { count: number; checksum: string }>;
  journal: { hash: string; created_at: string }[];
  catalog: unknown[];
  roles: unknown[];
}
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export function directPool(url: string): Pool {
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname.includes("-pooler")
  )
    throw new Error("A direct PostgreSQL URL is required");
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("ssl");
  return new Pool({
    connectionString: parsed.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
  });
}

export async function inventory(client: PoolClient, ownTransaction = true): Promise<Inventory> {
  if (ownTransaction) await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const info = await client.query(
      "select now()::text as measured_at, current_setting('server_version_num') as version",
    );
    const names = await client.query<{ schema: string; name: string }>(
      "select schemaname as schema, tablename as name from pg_tables where schemaname in ('public','drizzle') order by 1,2",
    );
    if (!names.rows.length) throw new Error("Empty catalog");
    const tables: Inventory["tables"] = {};
    for (const { schema, name } of names.rows) {
      const rows = await client.query<{ row_hash: string }>(
        "select encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') as row_hash from " +
          quote(schema) +
          "." +
          quote(name) +
          " t order by 1",
      );
      const digest = createHash("sha256");
      for (const row of rows.rows) digest.update(row.row_hash + "\n");
      tables[schema + "." + name] = { count: rows.rows.length, checksum: digest.digest("hex") };
    }
    const journal = await client.query<{ hash: string; created_at: string }>(
      "select hash, created_at::text from drizzle.__drizzle_migrations order by created_at,id",
    );
    const catalog =
      await client.query(`select 'table' as kind, schemaname as schema, tablename as name,
      jsonb_build_object('owner',tableowner,'rls',rowsecurity) as definition from pg_tables where schemaname in ('public','drizzle')
      union all select 'policy',schemaname,tablename || '.' || policyname,to_jsonb(p) from pg_policies p where schemaname='public'
      union all select 'constraint',n.nspname,c.relname || '.' || con.conname,jsonb_build_object('sql',pg_get_constraintdef(con.oid)) from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle')
      union all select 'grant',table_schema,table_name || '.' || grantee || '.' || privilege_type,to_jsonb(g) from information_schema.role_table_grants g where table_schema in ('public','drizzle')
      union all select 'index',schemaname,indexname,jsonb_build_object('sql',indexdef) from pg_indexes where schemaname in ('public','drizzle')
      order by 1,2,3`);
    const roles = await client.query(
      "select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles where rolname in ('app_runtime','neondb_owner') order by rolname",
    );
    const identity = await client.query(
      "select current_setting('neon.project_id',true) as project_id, current_setting('neon.branch_id',true) as branch_id, current_setting('neon.endpoint_id',true) as endpoint_id",
    );
    return {
      identity: identity.rows[0],
      ...info.rows[0],
      tables,
      journal: journal.rows,
      catalog: catalog.rows,
      roles: roles.rows,
    };
  } finally {
    if (ownTransaction) await client.query("ROLLBACK");
  }
}

export function compareInventories(source: Inventory, restored: Inventory) {
  const tableNames = [
    ...new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)]),
  ].sort((a, b) => a.localeCompare(b));
  const failures: string[] = [];
  if (!source.version.startsWith("17") || !restored.version.startsWith("17"))
    failures.push("postgres-major");
  for (const name of tableNames)
    if (JSON.stringify(source.tables[name]) !== JSON.stringify(restored.tables[name]))
      failures.push("table:" + name);
  for (const key of ["journal", "catalog", "roles"] as const)
    if (JSON.stringify(source[key]) !== JSON.stringify(restored[key])) failures.push(key);
  return { pass: failures.length === 0, tables_compared: tableNames.length, failures };
}

export function verifyLocalJournal(inv: Inventory, root: string) {
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const failures = journal.entries
    .filter(
      (e) =>
        inv.journal[e.idx]?.hash !==
        sha256(readFileSync(resolve(root, "drizzle/" + e.tag + ".sql"))),
    )
    .map((e) => e.tag);
  if (inv.journal.length !== journal.entries.length) failures.push("journal-count");
  return {
    pass: failures.length === 0,
    expected: journal.entries.length,
    actual: inv.journal.length,
    failures,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "snapshot-id": { type: "string" },
      "source-branch": { type: "string" },
      "restore-branch": { type: "string" },
    },
    strict: true,
  });
  if (
    !values["snapshot-id"] ||
    !values["source-branch"] ||
    !values["restore-branch"] ||
    values["source-branch"] === values["restore-branch"]
  )
    throw new Error("Explicit distinct branch IDs and snapshot ID required");
  if (!process.env.DATABASE_ADMIN_URL || !process.env.DATABASE_RESTORE_URL)
    throw new Error("Missing database connections");
  if (
    new URL(process.env.DATABASE_ADMIN_URL).hostname ===
    new URL(process.env.DATABASE_RESTORE_URL).hostname
  )
    throw new Error("Restore must use an isolated branch endpoint");
  const startedAt = new Date().toISOString();
  const source = directPool(process.env.DATABASE_ADMIN_URL),
    restored = directPool(process.env.DATABASE_RESTORE_URL);
  try {
    const a = await source.connect(),
      b = await restored.connect();
    try {
      const sourceInventory = await inventory(a),
        restoredInventory = await inventory(b);
      if (
        sourceInventory.identity?.branch_id !== values["source-branch"] ||
        restoredInventory.identity?.branch_id !== values["restore-branch"] ||
        sourceInventory.identity?.project_id !== restoredInventory.identity?.project_id
      )
        throw new Error("Server target identity mismatch");
      const comparison = compareInventories(sourceInventory, restoredInventory);
      const journal = verifyLocalJournal(sourceInventory, resolve(import.meta.dirname, "../.."));
      const result = {
        check: "m02:backup-verify",
        read_only: true,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        snapshot_id: values["snapshot-id"],
        source_branch: values["source-branch"],
        restore_branch: values["restore-branch"],
        result: comparison.pass && journal.pass ? "PASS" : "FAIL",
        comparison,
        journal,
        source: sourceInventory,
        restored: restoredInventory,
        limits:
          "Read-only comparison of public/drizzle at independent REPEATABLE READ snapshots. Requires source quiescence or comparison to the snapshot-time manifest. Does not prove RPO, Auth runtime, recovery key custody, external retention, or cross-tenant behavior. No credentials, row contents, or roles passwords are emitted. No resources are created or deleted.",
      };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.result === "PASS" ? 0 : 1;
    } finally {
      a.release();
      b.release();
    }
  } finally {
    await source.end();
    await restored.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      JSON.stringify({
        check: "m02:backup-verify",
        result: "ERROR",
        error:
          "Verification failed; check explicit targets, TLS, permissions and arguments. Database error details withheld.",
      }),
    );
    process.exitCode = 2;
  });
