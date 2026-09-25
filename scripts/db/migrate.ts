import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export function requireAdminUrl(): string {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error("DATABASE_ADMIN_URL é obrigatória para migrations");
  }
  return adminUrl;
}

/**
 * Migration 0004 is already published and must keep its recorded Drizzle hash.
 * On a database upgraded from 0003, normalize legacy sales totals before 0004
 * adds its arithmetic check. The preflight runs in a single transaction: item
 * totals are corrected, then each sale is reconciled to gross = sum(items).
 * When a sale's net_amount would end up above the reconciled gross, the whole
 * preflight aborts listing the sale ids and persists nothing. The commit is
 * independent from the Drizzle migration that follows; if 0004 later aborts,
 * totals stay normalized and consistent, and a re-run is idempotent. Databases
 * without the table or already carrying the final constraint are skipped.
 */
async function prepareLegacySalesTotals(pool: Pool): Promise<void> {
  const table = await pool.query<{ table_name: string | null }>(
    "select to_regclass('public.sales_items')::text as table_name",
  );
  if (!table.rows[0]?.table_name) return;

  const constraint = await pool.query<{ constraint_name: string }>(
    `select conname as constraint_name
     from pg_constraint
     where conrelid = 'public.sales_items'::regclass
       and conname = 'sales_items_total_amount_math_check'`,
  );
  if (constraint.rowCount) return;

  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `update public.sales_items
       set total_amount = round(quantity * unit_price, 4)
       where total_amount <> round(quantity * unit_price, 4)`,
    );

    const conflicts = await client.query<{ id: string }>(
      `select sale.id
       from public.sales as sale
       join (
         select sale_id, sum(total_amount) as gross
         from public.sales_items
         group by sale_id
       ) as totals on totals.sale_id = sale.id
       where sale.gross_amount <> totals.gross
         and sale.net_amount > totals.gross
       order by sale.id`,
    );
    if (conflicts.rowCount) {
      throw new Error(
        `Preflight da migration 0004 abortado: ${conflicts.rowCount} venda(s) com net_amount acima do total reconciliado dos itens: ${conflicts.rows.map((row) => row.id).join(", ")}. Reconcilie manualmente antes de migrar.`,
      );
    }

    await client.query(
      `update public.sales as sale
       set gross_amount = totals.gross
       from (
         select sale_id, sum(total_amount) as gross
         from public.sales_items
         group by sale_id
       ) as totals
       where sale.id = totals.sale_id
         and sale.gross_amount <> totals.gross`,
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations(adminUrl = requireAdminUrl()): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await prepareLegacySalesTotals(pool);
    const database = drizzle({ client: pool });
    await migrate(database, { migrationsFolder: resolve("drizzle") });
  } finally {
    await pool.end();
  }
}

interface Queryable {
  query(text: string): Promise<unknown>;
}

// SET ROLE exige membership com SET OPTION quando o admin não é superuser
// (Neon). O PostgreSQL 16+ concede automaticamente ao criador da role uma
// membership apenas administrativa (admin_option=true, set_option=false), que
// NÃO autoriza SET ROLE — é preciso um grant simples adicional. Localmente o
// admin é o superuser postgres e o grant é inócuo. Idempotente por construção.
export async function ensureRuntimeRoleMembership(client: Queryable): Promise<void> {
  await client.query(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'app_runtime')
         and not exists (
           select 1
           from pg_auth_members m
           join pg_roles granted on granted.oid = m.roleid
           join pg_roles member on member.oid = m.member
           where granted.rolname = 'app_runtime' and member.rolname = current_user
             and m.set_option
         ) then
        execute format('grant app_runtime to %I', current_user);
      end if;
    end
    $$;
  `);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log("Migrations PostgreSQL aplicadas com sucesso.");
}
