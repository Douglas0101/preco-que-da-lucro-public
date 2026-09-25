import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { DrizzlePurchasePriceRepository } from "../../src/server/repositories/purchase-price.repository";
import type { RequestContext } from "../../src/lib/request-context";
import { ensureRuntimeRoleMembership, requireAdminUrl, runMigrations } from "./migrate";

const adminUrl = requireAdminUrl();
const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000002";
const userA = "30000000-0000-4000-8000-000000000003";
const userB = "40000000-0000-4000-8000-000000000004";
const productA = "50000000-0000-4000-8000-000000000005";
const productB = "60000000-0000-4000-8000-000000000006";
const ingredientA = "70000000-0000-4000-8000-000000000007";
const packagingA = "80000000-0000-4000-8000-000000000008";
const historyA = "90000000-0000-4000-8000-000000000009";
const ingredientB = "a0000000-0000-4000-8000-00000000000a";
const legacySale = "b0000000-0000-4000-8000-00000000000b";
const legacySaleItem = "c0000000-0000-4000-8000-00000000000c";
const orphanHistory = "d0000000-0000-4000-8000-00000000000d";
const inconsistentSale = "ab000000-0000-4000-8000-0000000000ab";
const inconsistentSaleItem = "ac000000-0000-4000-8000-0000000000ac";
const expectedPostgresMajor = Number(process.env.EXPECTED_POSTGRES_MAJOR ?? "17");

if (!Number.isInteger(expectedPostgresMajor) || expectedPostgresMajor < 10) {
  throw new Error("EXPECTED_POSTGRES_MAJOR deve ser um major PostgreSQL inteiro >= 10");
}

async function withRuntimeContext<T>(
  client: Client,
  identity: { userId?: string; tenantId?: string },
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role app_runtime");
    if (identity.userId) {
      await client.query("select set_config('app.current_user_id', $1, true)", [identity.userId]);
    }
    if (identity.tenantId) {
      await client.query("select set_config('app.current_tenant_id', $1, true)", [
        identity.tenantId,
      ]);
    }
    const result = await operation();
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function withRuntimeCommit<T>(
  client: Client,
  identity: { userId?: string; tenantId?: string },
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role app_runtime");
    if (identity.userId) {
      await client.query("select set_config('app.current_user_id', $1, true)", [identity.userId]);
    }
    if (identity.tenantId) {
      await client.query("select set_config('app.current_tenant_id', $1, true)", [
        identity.tenantId,
      ]);
    }
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function seedIsolationFixtures(client: Client): Promise<void> {
  await client.query(
    `insert into users (id, name, email, email_verified)
     values ($1, 'Usuário A', 'a@example.test', true),
            ($2, 'Usuário B', 'b@example.test', true)`,
    [userA, userB],
  );
  await client.query(
    `insert into tenants (id, name, slug)
     values ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `insert into tenant_memberships (tenant_id, user_id, role)
     values ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [tenantA, userA, tenantB, userB],
  );
  await client.query(
    `insert into products (id, tenant_id, user_id, name, current_price, tax_rate)
     values ($1, $2, $3, 'Produto A', '12.3400', '0.060000'),
            ($4, $5, $6, 'Produto B', '99.9900', '0.120000')`,
    [productA, tenantA, userA, productB, tenantB, userB],
  );
  await client.query(
    `insert into product_ingredients
       (id, product_id, tenant_id, user_id, name, used_qty, used_unit,
        package_price, package_qty, package_unit)
     values ($1, $2, $3, $4, 'Ingrediente A', '1.000000', 'kg',
             '12.3000', '1.000000', 'kg')`,
    [ingredientA, productA, tenantA, userA],
  );
  await client.query(
    `insert into product_packaging
       (id, product_id, tenant_id, user_id, name, package_price, units_per_package)
     values ($1, $2, $3, $4, 'Embalagem A', '2.5000', '1.000000')`,
    [packagingA, productA, tenantA, userA],
  );
  await client.query(
    `insert into product_ingredients
       (id, product_id, tenant_id, user_id, name, used_qty, used_unit)
     values ($1, $2, $3, $4, 'Ingrediente B', '1.000000', 'kg')`,
    [ingredientB, productB, tenantB, userB],
  );
  await client.query(
    `insert into purchase_price_history
       (id, tenant_id, user_id, subject_type, subject_id, ingredient_id,
        price, quantity, unit, valid_from)
     values ($1, $2, $3, 'ingredient', $4, $4, '12.3000', '1.000000', 'kg',
             now() - interval '1 day')`,
    [historyA, tenantA, userA, ingredientA],
  );
}

async function assertDatabaseContract(client: Client): Promise<void> {
  const version = await client.query<{ serverVersionNum: string }>(
    "select current_setting('server_version_num') as \"serverVersionNum\"",
  );
  const serverVersionNum = Number(version.rows[0]?.serverVersionNum);
  const actualPostgresMajor = Math.floor(serverVersionNum / 10_000);
  assert.equal(
    actualPostgresMajor,
    expectedPostgresMajor,
    `PostgreSQL major incompatível: esperado ${expectedPostgresMajor}, atual ${actualPostgresMajor}`,
  );

  const role = await client.query<{
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
  }>(
    `select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
     from pg_roles where rolname = 'app_runtime'`,
  );
  assert.equal(role.rowCount, 1);
  assert.deepEqual(role.rows[0], {
    rolcanlogin: true,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolbypassrls: false,
  });

  const runtimePrivileges = await client.query<{
    rateLimitSelect: boolean;
    rateLimitInsert: boolean;
    publicRateLimitSelect: boolean;
    membershipFunctionExecute: boolean;
    tenantDelete: boolean;
    membershipDelete: boolean;
  }>(`
    select
      has_table_privilege('app_runtime', 'public.rate_limits', 'select') as "rateLimitSelect",
      has_table_privilege('app_runtime', 'public.rate_limits', 'insert') as "rateLimitInsert",
      has_table_privilege('public', 'public.rate_limits', 'select') as "publicRateLimitSelect",
      has_function_privilege('app_runtime', 'app_private.has_tenant_access(uuid)', 'execute') as "membershipFunctionExecute",
      has_table_privilege('app_runtime', 'public.tenants', 'delete') as "tenantDelete",
      has_table_privilege('app_runtime', 'public.tenant_memberships', 'delete') as "membershipDelete"
  `);
  assert.deepEqual(runtimePrivileges.rows[0], {
    rateLimitSelect: true,
    rateLimitInsert: true,
    publicRateLimitSelect: false,
    membershipFunctionExecute: true,
    tenantDelete: false,
    membershipDelete: false,
  });

  // 0011: as cinco tabelas de autenticação (identidade global, sem tenant_id)
  // ficam com RLS habilitado e política única de serviço `auth_service_access`
  // (FOR ALL, permissiva, exclusiva de app_runtime). A role legada com grants
  // permanece sem política = negada; owner/BYPASSRLS não é afetado.
  const authRls = await client.query<{
    table_name: string;
    rowsecurity: boolean;
    policy_count: string;
    policy_roles: string[];
    policy_cmd: string;
    policy_permissive: boolean;
  }>(
    `select c.relname as table_name,
            c.relrowsecurity as rowsecurity,
            (select count(*)::text
               from pg_policy p
              where p.polrelid = c.oid
                and p.polname = 'auth_service_access') as policy_count,
            coalesce(
              (select array_agg(r.rolname::text order by r.rolname)
                 from pg_policy p
                 cross join lateral unnest(p.polroles) as polrole(role_oid)
                 join pg_roles r on r.oid = polrole.role_oid
                where p.polrelid = c.oid
                  and p.polname = 'auth_service_access'),
              '{}'
            ) as policy_roles,
            coalesce(
              (select p.polcmd::text
                 from pg_policy p
                where p.polrelid = c.oid
                  and p.polname = 'auth_service_access'),
              ''
            ) as policy_cmd,
            coalesce(
              (select p.polpermissive
                 from pg_policy p
                where p.polrelid = c.oid
                  and p.polname = 'auth_service_access'),
              false
            ) as policy_permissive
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('users', 'sessions', 'accounts', 'verifications', 'rate_limits')
      order by c.relname`,
  );
  assert.deepEqual(
    authRls.rows,
    ["accounts", "rate_limits", "sessions", "users", "verifications"].map((table_name) => ({
      table_name,
      rowsecurity: true,
      policy_count: "1",
      policy_roles: ["app_runtime"],
      policy_cmd: "*",
      policy_permissive: true,
    })),
    "0011 deve deixar RLS + auth_service_access (FOR ALL permissiva → app_runtime) nas 5 tabelas de auth",
  );

  const ownedObjects = await client.query<{
    objectType: string;
    objectCount: string;
  }>(`
    with runtime as (
      select oid from pg_roles where rolname = 'app_runtime'
    )
    select object_type as "objectType", count(*)::text as "objectCount"
    from (
      select 'schema' as object_type
      from pg_namespace n
      join runtime on runtime.oid = n.nspowner
      where n.nspname not like 'pg_%'
        and n.nspname <> 'information_schema'
      union all
      select 'database' as object_type
      from pg_database d
      join runtime on runtime.oid = d.datdba
      where d.datname = current_database()
      union all
      select 'relation' as object_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join runtime on runtime.oid = c.relowner
      where n.nspname not like 'pg_%'
        and n.nspname <> 'information_schema'
      union all
      select 'function' as object_type
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join runtime on runtime.oid = p.proowner
      where n.nspname not like 'pg_%'
        and n.nspname <> 'information_schema'
      union all
      select 'type' as object_type
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      join runtime on runtime.oid = t.typowner
      where n.nspname not like 'pg_%'
        and n.nspname <> 'information_schema'
    ) owned
    group by object_type
    order by object_type
  `);
  assert.deepEqual(ownedObjects.rows, []);

  const scales = await client.query<{
    column_name: string;
    numeric_precision: number;
    numeric_scale: number;
  }>(
    `select column_name, numeric_precision, numeric_scale
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'products'
       and column_name in ('current_price', 'yield_qty', 'tax_rate')
     order by column_name`,
  );
  assert.deepEqual(scales.rows, [
    { column_name: "current_price", numeric_precision: 19, numeric_scale: 4 },
    { column_name: "tax_rate", numeric_precision: 9, numeric_scale: 6 },
    { column_name: "yield_qty", numeric_precision: 24, numeric_scale: 6 },
  ]);

  const rateLimitColumns = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = 'public' and table_name = 'rate_limits'
     order by ordinal_position`,
  );
  assert.deepEqual(rateLimitColumns.rows, [
    { column_name: "id", data_type: "text", is_nullable: "NO" },
    { column_name: "key", data_type: "text", is_nullable: "NO" },
    { column_name: "count", data_type: "integer", is_nullable: "NO" },
    { column_name: "last_request", data_type: "bigint", is_nullable: "NO" },
  ]);

  const privileges = await client.query<{
    runtime_create_schema: boolean;
    auth_delete: boolean;
    products_delete: boolean;
    tenants_delete: boolean;
    memberships_delete: boolean;
    audit_select: boolean;
    rate_limit_delete: boolean;
    purchase_history_select: boolean;
    purchase_history_update: boolean;
    sales_insert: boolean;
    sales_delete: boolean;
    sales_update: boolean;
    sales_items_update: boolean;
    simulations_update: boolean;
    snapshots_insert: boolean;
  }>(
    `select
       has_schema_privilege('app_runtime', 'public', 'CREATE') as runtime_create_schema,
       has_table_privilege('app_runtime', 'public.users', 'DELETE') as auth_delete,
       has_table_privilege('app_runtime', 'public.products', 'DELETE') as products_delete,
       has_table_privilege('app_runtime', 'public.tenants', 'DELETE') as tenants_delete,
       has_table_privilege('app_runtime', 'public.tenant_memberships', 'DELETE') as memberships_delete,
       has_table_privilege('app_runtime', 'public.audit_events', 'SELECT') as audit_select,
       has_table_privilege('app_runtime', 'public.rate_limits', 'DELETE') as rate_limit_delete,
       has_table_privilege('app_runtime', 'public.purchase_price_history', 'SELECT') as purchase_history_select,
       has_table_privilege('app_runtime', 'public.purchase_price_history', 'UPDATE') as purchase_history_update,
       has_table_privilege('app_runtime', 'public.sales', 'INSERT') as sales_insert,
       has_table_privilege('app_runtime', 'public.sales', 'DELETE') as sales_delete,
       has_table_privilege('app_runtime', 'public.sales', 'UPDATE') as sales_update,
       has_table_privilege('app_runtime', 'public.sales_items', 'UPDATE') as sales_items_update,
       has_table_privilege('app_runtime', 'public.simulations', 'UPDATE') as simulations_update,
       has_table_privilege('app_runtime', 'public.calculation_snapshots', 'INSERT') as snapshots_insert`,
  );
  assert.deepEqual(privileges.rows[0], {
    runtime_create_schema: false,
    auth_delete: true,
    products_delete: false,
    tenants_delete: false,
    memberships_delete: false,
    audit_select: false,
    rate_limit_delete: true,
    purchase_history_select: true,
    purchase_history_update: false,
    sales_insert: true,
    sales_delete: false,
    sales_update: false,
    sales_items_update: false,
    simulations_update: false,
    snapshots_insert: true,
  });

  const p1Columns = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `select table_name, column_name
     from information_schema.columns
     where table_schema = 'public'
       and ((table_name = 'products' and column_name = 'status')
         or (table_name = 'purchase_price_history' and column_name in ('ingredient_id', 'packaging_id'))
         or (table_name = 'simulations' and column_name in ('result', 'scenario_type', 'engine_version')))
     order by table_name, column_name`,
  );
  assert.deepEqual(p1Columns.rows, [
    { table_name: "products", column_name: "status" },
    { table_name: "purchase_price_history", column_name: "ingredient_id" },
    { table_name: "purchase_price_history", column_name: "packaging_id" },
    { table_name: "simulations", column_name: "engine_version" },
    { table_name: "simulations", column_name: "result" },
    { table_name: "simulations", column_name: "scenario_type" },
  ]);

  // 0013 (T2): products e expenses ganham version integer NOT NULL DEFAULT 0
  // com CHECK version >= 0.
  const versionColumns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select table_name, column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public'
       and table_name in ('products', 'expenses')
       and column_name = 'version'
     order by table_name`,
  );
  assert.deepEqual(versionColumns.rows, [
    {
      table_name: "expenses",
      column_name: "version",
      data_type: "integer",
      is_nullable: "NO",
      column_default: "0",
    },
    {
      table_name: "products",
      column_name: "version",
      data_type: "integer",
      is_nullable: "NO",
      column_default: "0",
    },
  ]);

  const versionChecks = await client.query<{ conname: string }>(
    `select conname
     from pg_constraint
     where conrelid in ('public.products'::regclass, 'public.expenses'::regclass)
       and conname in ('products_version_check', 'expenses_version_check')
     order by conname`,
  );
  assert.deepEqual(
    versionChecks.rows.map((row) => row.conname),
    ["expenses_version_check", "products_version_check"],
    "0013 deve criar CHECK version >= 0 nas duas tabelas",
  );

  await assert.rejects(
    client.query("update products set version = -1 where id = $1", [productA]),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23514",
    "CHECK version >= 0 deve rejeitar contador negativo",
  );

  // 0014 (RUM): série append-only sem tenant/RLS; app_runtime INSERT-only.
  const rumVitals = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = 'public' and table_name = 'rum_vitals'
     order by ordinal_position`,
  );
  assert.deepEqual(rumVitals.rows, [
    { column_name: "id", data_type: "uuid", is_nullable: "NO" },
    { column_name: "metric_id", data_type: "text", is_nullable: "NO" },
    { column_name: "name", data_type: "text", is_nullable: "NO" },
    { column_name: "value", data_type: "double precision", is_nullable: "NO" },
    { column_name: "rating", data_type: "text", is_nullable: "NO" },
    { column_name: "delta", data_type: "double precision", is_nullable: "NO" },
    { column_name: "navigation_type", data_type: "text", is_nullable: "YES" },
    { column_name: "received_at", data_type: "timestamp with time zone", is_nullable: "NO" },
  ]);

  const rumVitalsPrivileges = await client.query<{
    insert: boolean;
    select: boolean;
    update: boolean;
    delete: boolean;
    publicInsert: boolean;
    rowSecurity: boolean;
    tenantColumn: string | null;
  }>(
    `select
       has_table_privilege('app_runtime', 'public.rum_vitals', 'insert') as "insert",
       has_table_privilege('app_runtime', 'public.rum_vitals', 'select') as "select",
       has_table_privilege('app_runtime', 'public.rum_vitals', 'update') as "update",
       has_table_privilege('app_runtime', 'public.rum_vitals', 'delete') as "delete",
       has_table_privilege('public', 'public.rum_vitals', 'insert') as "publicInsert",
       c.relrowsecurity as "rowSecurity",
       (select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'rum_vitals'
           and column_name = 'tenant_id') as "tenantColumn"
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'rum_vitals'`,
  );
  assert.deepEqual(
    rumVitalsPrivileges.rows[0],
    {
      insert: true,
      select: false,
      update: false,
      delete: false,
      publicInsert: false,
      rowSecurity: false,
      tenantColumn: null,
    },
    "0014 deve manter rum_vitals INSERT-only para app_runtime, sem RLS e sem tenant_id",
  );

  await assert.rejects(
    client.query(
      `insert into products (tenant_id, user_id, name, tax_rate)
       values ($1, $2, 'Taxa inválida', '1.000001')`,
      [tenantA, userA],
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23514",
  );

  const ownRows = await withRuntimeContext(client, { userId: userA, tenantId: tenantA }, async () =>
    client.query<{ name: string }>("select name from products where tenant_id = $1", [tenantA]),
  );
  assert.deepEqual(
    ownRows.rows.map((row) => row.name),
    ["Produto A"],
  );

  const membershipAccess = await withRuntimeContext(
    client,
    { userId: userA, tenantId: tenantA },
    async () =>
      client.query<{ own: boolean; other: boolean }>(
        "select app_private.has_tenant_access($1::uuid) as own, app_private.has_tenant_access($2::uuid) as other",
        [tenantA, tenantB],
      ),
  );
  assert.deepEqual(membershipAccess.rows[0], { own: true, other: false });

  const crossTenantRows = await withRuntimeContext(
    client,
    { userId: userA, tenantId: tenantB },
    async () => client.query("select id from products where tenant_id = $1", [tenantB]),
  );
  assert.equal(crossTenantRows.rowCount, 0);

  const missingContextRows = await withRuntimeContext(client, {}, async () =>
    client.query("select id from products"),
  );
  assert.equal(missingContextRows.rowCount, 0);

  await assert.rejects(
    withRuntimeContext(client, { userId: userA, tenantId: tenantA }, async () =>
      client.query(
        `insert into expenses (tenant_id, user_id, name, amount, type)
         values ($1, $2, 'Cross tenant', '10.0000', 'fixa')`,
        [tenantB, userA],
      ),
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "42501",
  );

  const tenantASale = await withRuntimeCommit(
    client,
    { userId: userA, tenantId: tenantA },
    async () => {
      const sale = await client.query<{ id: string }>(
        `insert into sales (tenant_id, user_id, occurred_at, gross_amount, net_amount, channel)
         values ($1, $2, now(), '20.0000', '20.0000', 'manual')
         returning id`,
        [tenantA, userA],
      );
      await client.query(
        `insert into sales_items
           (tenant_id, user_id, sale_id, product_id, quantity, unit_price, total_amount)
         values ($1, $2, $3, $4, '2.000000', '10.0000', '20.0000')`,
        [tenantA, userA, sale.rows[0]?.id, productA],
      );
      return sale.rows[0]?.id;
    },
  );
  assert.ok(tenantASale);

  const historyTimestamps = await client.query<{
    valid_from: Date;
    recorded_at: Date;
  }>(
    `select valid_from, recorded_at
     from purchase_price_history
     where id = $1`,
    [historyA],
  );
  assert.equal(historyTimestamps.rowCount, 1);
  assert.ok(
    historyTimestamps.rows[0]!.recorded_at > historyTimestamps.rows[0]!.valid_from,
    "recorded_at deve usar o timestamp do banco, independente de valid_from",
  );

  await assert.rejects(
    withRuntimeCommit(client, { userId: userA, tenantId: tenantA }, async () =>
      client.query("delete from product_ingredients where tenant_id = $1 and id = $2", [
        tenantA,
        ingredientA,
      ]),
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23503",

    "filho com histórico não pode ser removido enquanto o histórico for append-only",
  );

  const historyCount = await client.query<{ count: string }>(
    "select count(*)::text as count from purchase_price_history where id = $1",
    [historyA],
  );
  assert.equal(historyCount.rows[0]?.count, "1");

  await assert.rejects(
    client.query(
      `insert into purchase_price_history
         (tenant_id, user_id, subject_type, subject_id, ingredient_id,
          price, quantity, unit, valid_from)
       values ($1, $2, 'ingredient', $3, $3, '12.3000', '1.000000', 'kg', now())`,
      [tenantA, userA, ingredientB],
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23503",
    "a FK composta deve rejeitar referência ao mesmo sujeito em outro tenant",
  );

  const totalMath = await client.query<{ mismatches: string }>(
    `select count(*)::text as mismatches
     from sales_items
     where total_amount <> round(quantity * unit_price, 4)`,
  );
  assert.equal(totalMath.rows[0]?.mismatches, "0");

  await assert.rejects(
    withRuntimeCommit(client, { userId: userA, tenantId: tenantA }, async () =>
      client.query(
        `insert into sales (tenant_id, user_id, occurred_at, gross_amount, net_amount, channel)
         values ($1, $2, now(), '10.0000', '10.0000', 'manual')`,
        [tenantA, userA],
      ),
    ),
    (error: unknown) => error instanceof Error && error.message.includes("SALE_REQUIRES_ITEM"),
  );

  await client.query("delete from sales where id = $1", [tenantASale]);

  const crossTenantSales = await withRuntimeContext(
    client,
    { userId: userB, tenantId: tenantB },
    async () => client.query("select id from sales where tenant_id = $1", [tenantA]),
  );
  assert.equal(crossTenantSales.rowCount, 0);
}

async function assertPurchasePriceConcurrency(adminUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const database = drizzle({ client: pool, schema });
  const repository = new DrizzlePurchasePriceRepository();
  const input = {
    kind: "packaging" as const,
    subjectId: packagingA,
    price: "2.5000",
    quantity: "1.000000",
    unit: "unidade",
    validFrom: new Date("2026-08-15T13:00:00.000Z"),
  };

  const append = () =>
    database.transaction(async (transaction) => {
      const context: RequestContext = {
        userId: userA,
        tenantId: tenantA,
        roles: ["owner"],
        correlationId: "db-test-purchase-price-concurrency",
        signal: AbortSignal.timeout(10_000),
        transaction: transaction as unknown as RequestContext["transaction"],
      };
      return repository.append(context, input);
    });

  try {
    const [first, second] = await Promise.all([append(), append()]);
    assert.equal(first.id, second.id, "concorrência não pode criar histórico duplicado");

    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from purchase_price_history
       where tenant_id = $1 and subject_type = 'packaging' and subject_id = $2`,
      [tenantA, packagingA],
    );
    assert.equal(count.rows[0]?.count, "1");

    await assert.rejects(
      pool.query("delete from product_packaging where tenant_id = $1 and id = $2", [
        tenantA,
        packagingA,
      ]),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "23503",
      "embalagem com histórico deve respeitar ON DELETE RESTRICT",
    );

    const retained = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from purchase_price_history
       where tenant_id = $1 and subject_type = 'packaging' and subject_id = $2`,
      [tenantA, packagingA],
    );
    assert.equal(retained.rows[0]?.count, "1");
  } finally {
    await pool.query(
      "delete from purchase_price_history where tenant_id = $1 and subject_id = $2",
      [tenantA, packagingA],
    );
    await pool.end();
  }
}

// Downs que levam a chain 0019→0003, na ordem de aplicação (mais nova primeiro).
const DOWNS_TIP_TO_0003 = [
  "0019_to_0018_down.sql",
  "0018_to_0017_down.sql",
  "0017_to_0016_down.sql",
  "0016_to_0015_down.sql",
  "0015_to_0014_down.sql",
  "0014_to_0013_down.sql",
  "0013_to_0012_down.sql",
  "0012_to_0011_down.sql",
  "0011_to_0010_down.sql",
  "0010_to_0009_down.sql",
  "0009_to_0008_down.sql",
  "0008_to_0007_down.sql",
  "0007_to_0006_down.sql",
  "0006_to_0005_down.sql",
  "0005_to_0004_down.sql",
  "0004_to_0003_down.sql",
];

async function applyDowns(client: Client, downFiles: string[]): Promise<void> {
  // O chain pode ter migrations além do destino do rollback; é preciso desfazer
  // cada arquivo da lista e remover exatamente o mesmo número de entradas do
  // journal, senão o re-run tenta CREATE/ADD/DROP em objetos que ainda existem.
  for (const downFile of downFiles) {
    const sql = await readFile(resolve("drizzle/rollback", downFile), "utf8");
    await client.query(sql);
  }
  await client.query(
    `delete from drizzle.__drizzle_migrations where id in (select id from drizzle.__drizzle_migrations order by id desc limit ${downFiles.length})`,
  );
}

async function rollbackTo0003(client: Client): Promise<void> {
  await applyDowns(client, DOWNS_TIP_TO_0003);
}

async function assertUpgradeFrom0003(adminUrl: string, client: Client): Promise<void> {
  await rollbackTo0003(client);

  await client.query(
    `insert into sales (id, tenant_id, user_id, occurred_at, gross_amount, net_amount, channel)
     values ($1, $2, $3, now(), '1.0000', '1.0000', 'manual')`,
    [legacySale, tenantA, userA],
  );
  await client.query(
    `insert into sales_items
       (id, sale_id, product_id, tenant_id, user_id, quantity, unit_price, total_amount)
     values ($1, $2, $3, $4, $5, '3.000000', '0.3334', '1.0001')`,
    [legacySaleItem, legacySale, productA, tenantA, userA],
  );

  await runMigrations(adminUrl);
  const corrected = await client.query<{ total_amount: string }>(
    "select total_amount::text as total_amount from sales_items where id = $1",
    [legacySaleItem],
  );
  assert.equal(corrected.rows[0]?.total_amount, "1.0002");

  const reconciledSale = await client.query<{ gross_amount: string; net_amount: string }>(
    "select gross_amount::text as gross_amount, net_amount::text as net_amount from sales where id = $1",
    [legacySale],
  );
  assert.deepEqual(
    reconciledSale.rows[0],
    { gross_amount: "1.0002", net_amount: "1.0000" },
    "preflight deve reconciliar gross_amount com a soma corrigida dos itens, sem tocar net_amount",
  );

  await rollbackTo0003(client);

  await client.query(
    `insert into sales (id, tenant_id, user_id, occurred_at, gross_amount, net_amount, channel)
     values ($1, $2, $3, now(), '1.0000', '1.5000', 'manual')`,
    [inconsistentSale, tenantA, userA],
  );
  await client.query(
    `insert into sales_items
       (id, sale_id, product_id, tenant_id, user_id, quantity, unit_price, total_amount)
     values ($1, $2, $3, $4, $5, '3.000000', '0.3334', '1.0001')`,
    [inconsistentSaleItem, inconsistentSale, productA, tenantA, userA],
  );

  await assert.rejects(
    runMigrations(adminUrl),
    (error: unknown) => error instanceof Error && error.message.includes(inconsistentSale),
    "preflight deve abortar listando a venda cujo net_amount excede o total reconciliado",
  );

  const untouchedItem = await client.query<{ total_amount: string }>(
    "select total_amount::text as total_amount from sales_items where id = $1",
    [inconsistentSaleItem],
  );
  assert.equal(
    untouchedItem.rows[0]?.total_amount,
    "1.0001",
    "preflight abortado não pode persistir a correção dos itens",
  );
  const untouchedSale = await client.query<{ gross_amount: string }>(
    "select gross_amount::text as gross_amount from sales where id = $1",
    [inconsistentSale],
  );
  assert.equal(
    untouchedSale.rows[0]?.gross_amount,
    "1.0000",
    "preflight abortado não pode persistir reconciliação parcial",
  );

  await client.query("delete from sales_items where id = $1", [inconsistentSaleItem]);
  await client.query("delete from sales where id = $1", [inconsistentSale]);

  await client.query(
    `insert into purchase_price_history
       (id, tenant_id, user_id, subject_type, subject_id, price, quantity, unit, valid_from)
     values ($1, $2, $3, 'ingredient', $4, '4.0000', '1.000000', 'kg', now())`,
    [orphanHistory, tenantA, userA, "f0000000-0000-4000-8000-00000000000f"],
  );

  await assert.rejects(
    runMigrations(adminUrl),
    (error: unknown) => error instanceof Error && error.message.includes("orphaned target"),
    "0004 deve abortar quando o histórico legado aponta para um órfão",
  );

  await client.query("delete from purchase_price_history where id = $1", [orphanHistory]);
  await runMigrations(adminUrl);
}

async function assertDowngrade0002To0001AndReplay(adminUrl: string, client: Client): Promise<void> {
  // Completa a cobertura da cadeia de rollback: além de 0019→0003, aplica
  // 0003→0002 e o novo 0002→0001, deixando o banco no estado da migration 0001
  // com o journal reduzido a 0000/0001 — uma linha do journal por arquivo
  // aplicado (`applyDowns` deriva o número de `downFiles.length`; nenhum total é
  // escrito à mão, então acrescentar down à lista não envelhece este comentário).
  await applyDowns(client, [
    ...DOWNS_TIP_TO_0003,
    "0003_to_0002_down.sql",
    "0002_to_0001_down.sql",
  ]);

  const journal = await client.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations",
  );
  assert.equal(journal.rows[0]?.count, "2", "journal deve reter somente 0000 e 0001");

  const dropped = await client.query<{
    rateLimits: string | null;
    sales: string | null;
    purchaseHistory: string | null;
  }>(
    `select to_regclass('public.rate_limits')::text as "rateLimits",
            to_regclass('public.sales')::text as "sales",
            to_regclass('public.purchase_price_history')::text as "purchaseHistory"`,
  );
  assert.deepEqual(
    dropped.rows[0],
    { rateLimits: null, sales: null, purchaseHistory: null },
    "0002→0001 deve remover rate_limits sem dependentes; 0003→0002 remove as tabelas P1",
  );

  // Os guards IF EXISTS do down de 0002 o tornam no-op na segunda aplicação.
  const idempotentAgain = await readFile(resolve("drizzle/rollback/0002_to_0001_down.sql"), "utf8");
  await client.query(idempotentAgain);

  // Replay completo 0002→0019: valida reprodutibilidade de 0002 e 0003.
  await runMigrations(adminUrl);

  const replayedJournal = await client.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations",
  );
  assert.equal(replayedJournal.rows[0]?.count, "20", "replay deve restaurar o journal completo");

  const restored = await client.query<{
    rateLimits: boolean;
    rateLimitSelect: boolean;
    rateLimitInsert: boolean;
    rateLimitDelete: boolean;
    publicRateLimitSelect: boolean;
    sales: boolean;
  }>(
    `select to_regclass('public.rate_limits') is not null as "rateLimits",
            has_table_privilege('app_runtime', 'public.rate_limits', 'select') as "rateLimitSelect",
            has_table_privilege('app_runtime', 'public.rate_limits', 'insert') as "rateLimitInsert",
            has_table_privilege('app_runtime', 'public.rate_limits', 'delete') as "rateLimitDelete",
            has_table_privilege('public', 'public.rate_limits', 'select') as "publicRateLimitSelect",
            to_regclass('public.sales') is not null as "sales"`,
  );
  assert.deepEqual(
    restored.rows[0],
    {
      rateLimits: true,
      rateLimitSelect: true,
      rateLimitInsert: true,
      rateLimitDelete: true,
      publicRateLimitSelect: false,
      sales: true,
    },
    "replay deve recriar rate_limits com grants idênticos a 0002 (PUBLIC revogado, app_runtime CRUD)",
  );

  const empty = await client.query<{ count: string }>(
    "select count(*)::text as count from rate_limits",
  );
  assert.equal(empty.rows[0]?.count, "0");

  await withRuntimeCommit(client, {}, async () => {
    await client.query(
      `insert into rate_limits (key, count, last_request)
       values ('s2-replay-probe', 1, $1)
       on conflict (key) do update set count = rate_limits.count + 1, last_request = excluded.last_request`,
      [Date.now()],
    );
    await client.query("delete from rate_limits where key = 's2-replay-probe'");
  });
}

async function main(): Promise<void> {
  await runMigrations(adminUrl);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await ensureRuntimeRoleMembership(client);
    await seedIsolationFixtures(client);
    await assertDatabaseContract(client);
    await assertPurchasePriceConcurrency(adminUrl);
    await assertUpgradeFrom0003(adminUrl, client);
    await assertDowngrade0002To0001AndReplay(adminUrl, client);

    // SKIP_FINAL_ROLLBACK=1 pula o rollback 0001→0000, que dropa a role global
    // app_runtime — objeto compartilhado entre databases do mesmo servidor.
    // Usado em banco de prova isolado; o fluxo padrão (test DB dedicada) mantém o passo.
    if (!process.env.SKIP_FINAL_ROLLBACK) {
      const rollbackSql = await readFile(resolve("drizzle/rollback/0001_to_0000_down.sql"), "utf8");
      await client.query(rollbackSql);
      const rolledBack = await client.query<{ table_name: string | null }>(
        "select to_regclass('public.products')::text as table_name",
      );
      assert.equal(rolledBack.rows[0]?.table_name, null);
    }
  } finally {
    await client.end();
  }

  // A rollback must leave a database where the complete migration chain can be replayed.
  await runMigrations(adminUrl);
  console.log(
    `PostgreSQL ${expectedPostgresMajor}, migration zero, constraints, RLS, P1 tables, cross-tenant e rollback: OK`,
  );
}

await main();
