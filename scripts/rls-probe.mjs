// rls-probe.mjs — sonda H-07 da matriz de hipóteses do cutover A4
// (docs/runbooks/a4-matriz-hipoteses.md "Design H-07"). Exercita a NEGAÇÃO
// cross-tenant como `app_runtime` em runtime: leitura E escrita, nos dois
// sentidos (A→B e B→A), + catálogo de roles/owners (§11.9/§32). Fecha o
// residual §42 (RLS) quando executado contra o banco alvo.
//
// Contrato:
//   node scripts/rls-probe.mjs --target-env <NOME_DA_ENV> [--out <caminho.md>] [--cleanup]
//   - A URL de conexão vem SEMPRE da variável de ambiente cujo NOME é passado
//     em argv (nunca valor em argv, nunca impressa).
//   - Fase SEED (única escrita sancionada): 2 tenants + 2 usuários marcadores
//     no domínio `@preco-que-da.test` + 1 produto por tenant + membership do
//     admin em `app_runtime` (idempotente; SQL sempre parametrizado; ids fixos
//     uuid v4 registrados na evidência).
//   - Fase PROBE (transação que termina em rollback): `SET ROLE app_runtime` +
//     set_config(app.current_user_id / app.current_tenant_id /
//     app.current_roles) e tentativas cross-tenant. QUALQUER vazamento
//     (linhas de B visíveis/mutáveis pela tenant A) = VIOLAÇÃO: JSON
//     {result:"VIOLATION"} no stdout e exit 4 — nada é "consertado".
//   - Fase CATÁLOGO (read-only): rolsuper/rolbypassrls de app_runtime e owner
//     das tabelas tenant ≠ app_runtime.
//   - Cleanup do seed: por padrão NÃO deleta (branch efêmera é deletada
//     inteira no V4, §12.5). Com --cleanup, apaga as linhas de seed ao final
//     do drill efêmero e verifica contagens = 0; production é proibida.
//   - Alvo remoto: somente DATABASE_RESTORE_URL direct em branch
//     drill-branch, com ALLOW_REMOTE_DB e motivo; production/pooler falham
//     antes de abrir socket. Produção permanece read-only nesta modalidade.
//   - Erros de banco são FAIL-LOUD sanitizados (Fase A3): código, mensagem,
//     detail/hint/tabela visíveis; URLs/credenciais/hosts redigidos
//     (./rls-probe-errors.mjs). A supressão total anterior causou o 42P01
//     DESCONHECIDO de C-02A e é proibida.
//   - Saída: JSON no stdout + Markdown e JSON companheiro ao lado do --out.
// Exit codes: 0 = PASS (todas as negações confirmadas) · 4 = VIOLATION
// (vazamento cross-tenant — gatilho de parada da rodada) · 2 = erro de
// ambiente/banco (fail-closed).

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { dbErrorSummary } from "./rls-probe-errors.mjs";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const MARKER_DOMAIN = "@preco-que-da.test";
const PRODUCTION_ENDPOINT_PREFIX = "ep-long-violet-aye9g0bn";

// Ids fixos uuid v4 (gerados e registrados na evidência; re-run = idempotente;
// --cleanup apaga exatamente por estes ids).
const TENANT_A_ID = "48cc4be3-de57-40f9-b68e-97584b3a6a6c";
const TENANT_B_ID = "989823a1-3521-48cb-951e-d52418fb4d96";
const USER_A_ID = "88912fae-1e8d-471f-9c95-a8673c00e004";
const USER_B_ID = "226a6e16-4d11-4e93-8d9f-3c637ab1fc24";
const PRODUCT_A_ID = "2f9ae036-4d10-4a0b-b14c-412f93c29c8d";
const PRODUCT_B_ID = "dcb9d6c7-c8dc-4208-a847-6c78116d0f68";

const TENANT_A = { id: TENANT_A_ID, slug: "probe-a-tenant", email: `rls-probe-a${MARKER_DOMAIN}` };
const TENANT_B = { id: TENANT_B_ID, slug: "probe-b-tenant", email: `rls-probe-b${MARKER_DOMAIN}` };

function usage() {
  return [
    "uso: node scripts/rls-probe.mjs --target-env <NOME_DA_ENV> [--out <caminho.md>] [--cleanup]",
    "A URL de conexão é lida da variável de ambiente indicada (valor nunca impresso).",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { targetEnv: undefined, out: undefined, cleanup: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      if (arg === `--${name}`) {
        index += 1;
        return argv[index];
      }
      return undefined;
    };
    if (arg.startsWith("--target-env")) {
      parsed.targetEnv = take("target-env");
    } else if (arg.startsWith("--out")) {
      parsed.out = take("out");
    } else if (arg === "--cleanup") {
      parsed.cleanup = true;
    } else {
      return { error: `argumento não reconhecido: ${arg}` };
    }
  }
  if (typeof parsed.targetEnv !== "string" || parsed.targetEnv.trim() === "") {
    return { error: "--target-env é obrigatório" };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.targetEnv)) {
    return { error: "--target-env deve ser o NOME de uma variável de ambiente" };
  }
  if (parsed.out !== undefined && !/\.md$/.test(parsed.out)) {
    return { error: "--out deve apontar para um arquivo .md" };
  }
  return parsed;
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

/** Identidade segura para evidência: nunca persistir hostname ou endpoint id. */
function maskedTarget(url) {
  try {
    const parsed = new URL(url);
    return {
      host: "<host-mascarado>",
      database: parsed.pathname.replace(/^\//, ""),
      role: parsed.username,
    };
  } catch {
    return { host: "<host-mascarado>", database: "?", role: "?" };
  }
}

function validateTarget(url, targetEnv) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL de alvo malformada");
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes(PRODUCTION_ENDPOINT_PREFIX)) {
    throw new Error("probe remoto contra production proibido; use branch drill");
  }
  if (isLocalUrl(url)) return;
  if (targetEnv !== "DATABASE_RESTORE_URL") {
    throw new Error("probe remoto exige DATABASE_RESTORE_URL como alvo efemero");
  }
  if (host.includes("-pooler")) throw new Error("probe remoto exige endpoint direct");
  if (process.env.NEON_MIGRATION_TARGET_KIND !== "drill-branch") {
    throw new Error("probe remoto exige NEON_MIGRATION_TARGET_KIND=drill-branch");
  }
  const motivo = process.env.ALLOW_REMOTE_DB?.trim();
  if (!motivo) throw new Error("probe remoto exige ALLOW_REMOTE_DB com motivo");
  if (motivo.includes("://")) throw new Error("motivo nao pode conter URL");
}

/** FAIL-LOUD sanitizado (Fase A3): erro completo visível, segredos redigidos.
 * Implementação importada de ./rls-probe-errors.mjs (testável sem socket). */

function makeClient(url) {
  return new Client({
    connectionString: url,
    ssl: isLocalUrl(url) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
    application_name: "m02-rls-probe",
  });
}

// ---------------------------------------------------------------------------
// Fase SEED
// ---------------------------------------------------------------------------

/** Membership do admin em app_runtime com SET OPTION (SET ROLE exige; Neon
 * PG17 concede ao criador apenas admin_option). Mesmo SQL idempotente de
 * scripts/db/migrate.ts (ensureRuntimeRoleMembership). */
const ENSURE_RUNTIME_MEMBERSHIP_SQL = `
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
`;

function membershipState(client) {
  return client.query(
    `select m.admin_option, m.set_option
       from pg_auth_members m
       join pg_roles granted on granted.oid = m.roleid
       join pg_roles member on member.oid = m.member
      where granted.rolname = 'app_runtime' and member.rolname = current_user`,
  );
}

async function seedPhase(client) {
  const before = (await membershipState(client)).rows;
  await client.query(ENSURE_RUNTIME_MEMBERSHIP_SQL);
  const after = (await membershipState(client)).rows;
  const membership = {
    set_option_before: before.some((row) => row.set_option),
    set_option_after: after.some((row) => row.set_option),
    created_by_probe: !before.some((row) => row.set_option) && after.some((row) => row.set_option),
  };
  if (!membership.set_option_after) {
    throw new Error("membership app_runtime sem SET OPTION após ensure — SET ROLE indisponível");
  }

  // tenants
  for (const tenant of [TENANT_A, TENANT_B]) {
    await client.query(
      `insert into tenants (id, name, slug, kind)
       values ($1, $2, $3, 'personal')
       on conflict do nothing`,
      [tenant.id, `RLS Probe Tenant ${tenant.slug === TENANT_A.slug ? "A" : "B"}`, tenant.slug],
    );
  }
  // usuários marcadores
  for (const [index, tenant] of [TENANT_A, TENANT_B].entries()) {
    const userId = index === 0 ? USER_A_ID : USER_B_ID;
    await client.query(
      `insert into users (id, name, email, email_verified)
       values ($1, $2, $3, false)
       on conflict do nothing`,
      [userId, `RLS Probe User ${index === 0 ? "A" : "B"}`, tenant.email],
    );
    // membership owner (necessária para has_tenant_access do próprio tenant)
    await client.query(
      `insert into tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'owner')
       on conflict do nothing`,
      [tenant.id, userId],
    );
  }
  // 1 produto por tenant (alvo do teste de UPDATE)
  await client.query(
    `insert into products (id, tenant_id, user_id, name, current_price, yield_qty, yield_unit, is_demo)
     values ($1, $2, $3, $4, 10.0000, 1.000000, 'unidade', false)
     on conflict do nothing`,
    [PRODUCT_A_ID, TENANT_A.id, USER_A_ID, "RLS Probe Product A"],
  );
  await client.query(
    `insert into products (id, tenant_id, user_id, name, current_price, yield_qty, yield_unit, is_demo)
     values ($1, $2, $3, $4, 20.0000, 2.000000, 'unidade', false)
     on conflict do nothing`,
    [PRODUCT_B_ID, TENANT_B.id, USER_B_ID, "RLS Probe Product B"],
  );

  // verificação do seed (leitura, por ids fixos)
  const counts = {};
  const countBy = async (label, sql, params) => {
    const result = await client.query(sql, params);
    counts[label] = Number(result.rows[0].n);
  };
  await countBy("tenants", `select count(*)::bigint as n from tenants where id = any($1::uuid[])`, [
    [TENANT_A.id, TENANT_B.id],
  ]);
  await countBy("users", `select count(*)::bigint as n from users where id = any($1::text[])`, [
    [USER_A_ID, USER_B_ID],
  ]);
  await countBy(
    "memberships",
    `select count(*)::bigint as n from tenant_memberships where (tenant_id, user_id) in (($1, $2), ($3, $4))`,
    [TENANT_A.id, USER_A_ID, TENANT_B.id, USER_B_ID],
  );
  await countBy(
    "products",
    `select count(*)::bigint as n from products where id = any($1::uuid[])`,
    [[PRODUCT_A_ID, PRODUCT_B_ID]],
  );
  const expectedCounts = { tenants: 2, users: 2, memberships: 2, products: 2 };
  const ok = Object.entries(expectedCounts).every(([key, value]) => counts[key] === value);
  return {
    membership,
    ids: {
      tenants: [TENANT_A.id, TENANT_B.id],
      users: [USER_A_ID, USER_B_ID],
      products: [PRODUCT_A_ID, PRODUCT_B_ID],
    },
    slugs: [TENANT_A.slug, TENANT_B.slug],
    emails: [TENANT_A.email, TENANT_B.email],
    counts,
    ok,
  };
}

// ---------------------------------------------------------------------------
// Fase PROBE
// ---------------------------------------------------------------------------

/**
 * Executa um bloco de probes como app_runtime personificado (SET ROLE +
 * set_config transaction-local) dentro de transação com rollback garantido.
 * `run(ctx)` recebe { query } e devolve a lista de probes já classificados.
 */
async function probeSession(client, label, userId, tenantId, run) {
  await client.query("begin");
  try {
    await client.query("set role app_runtime");
    await client.query(
      `select set_config('app.current_user_id', $1, true),
              set_config('app.current_tenant_id', $2, true),
              set_config('app.current_roles', $3, true)`,
      [userId, tenantId, "member"],
    );
    const context = await client.query(
      `select current_user as role,
              current_setting('app.current_user_id', true) as user_id,
              current_setting('app.current_tenant_id', true) as tenant_id,
              current_setting('app.current_roles', true) as roles`,
    );
    const ctx = context.rows[0];
    if (
      ctx.role !== "app_runtime" ||
      ctx.user_id !== userId ||
      ctx.tenant_id !== tenantId ||
      ctx.roles !== "member"
    ) {
      throw new Error("contexto de sessão app_runtime não confere após set_config");
    }
    const query = (text, params = []) => client.query(text, params);
    const probes = await run(query);
    return { label, context: ctx, probes };
  } finally {
    // rollback reverte SET ROLE, set_config e qualquer mutação acidental
    try {
      await client.query("rollback");
    } catch {
      // sessão já encerrada; nada a fazer
    }
  }
}

function isPolicyError(error) {
  return error?.code === "42501" && /row-level security/i.test(String(error?.message ?? ""));
}

function denialFromError(error) {
  const policy = isPolicyError(error);
  return {
    probe: null,
    operacao: null,
    esperado: "negado (0 linhas ou erro de policy)",
    obtido: `erro ${error?.code ?? "DESCONHECIDO"}${policy ? " (policy RLS)" : ""}`,
    // erro de policy RLS = negação confirmada; erro NÃO-policy = negação não
    // atribuível a RLS (ex.: grant ausente) — falha, nunca "pass".
    pass: policy,
    detalhe: policy
      ? "negado por exceção de policy RLS"
      : "negado por exceção NÃO-policy do banco (código registrado; mensagem omitida por norma)",
    erro: dbErrorSummary(error),
  };
}

/** Savepoint por probe: um erro esperado (policy RLS) não pode envenenar a
 * transação com 25P02 e invalidar os probes seguintes. Nomes de savepoint são
 * fixos (sem interpolação de input). */
function makeSavepointRunner(query) {
  let counter = 0;
  return async (fn) => {
    counter += 1;
    const name = `sp_rls_probe_${counter}`;
    await query(`savepoint ${name}`);
    try {
      const result = await fn();
      await query(`release savepoint ${name}`);
      return result;
    } catch (error) {
      try {
        await query(`rollback to savepoint ${name}`);
        await query(`release savepoint ${name}`);
      } catch {
        // transação irrecuperável: o rollback externo da sessão protege
      }
      throw error;
    }
  };
}

async function crossTenantProbes(query, other, otherUserId, otherProductId) {
  const probes = [];
  const inSavepoint = makeSavepointRunner(query);

  // (a) leitura cross-tenant em products
  const readOther = await query(`select count(*)::bigint as n from products where tenant_id = $1`, [
    other.id,
  ]);
  probes.push({
    probe: "a-leitura-products-b",
    operacao: `SELECT count(*) FROM products WHERE tenant_id = ${other.slug}`,
    esperado: 0,
    obtido: Number(readOther.rows[0].n),
    pass: Number(readOther.rows[0].n) === 0,
    detalhe: "RLS tenant_isolation deve ocultar integralmente as linhas da outra tenant",
  });

  // (a2) leitura total: apenas a própria linha deve ser visível
  const readAll = await query(`select count(*)::bigint as n from products`, []);
  probes.push({
    probe: "a2-leitura-products-total",
    operacao: "SELECT count(*) FROM products (visibilidade total como app_runtime)",
    esperado: 1,
    obtido: Number(readAll.rows[0].n),
    pass: Number(readAll.rows[0].n) === 1,
    detalhe: "somente a própria linha de seed deve estar visível",
  });

  // (b) UPDATE cross-tenant
  try {
    const updated = await inSavepoint(() =>
      query(`update products set updated_at = updated_at where id = $1`, [otherProductId]),
    );
    probes.push({
      probe: "b-update-products-b",
      operacao: `UPDATE products SET updated_at = updated_at WHERE id = <product ${other.slug}>`,
      esperado: "0 rows affected (ou erro de policy)",
      obtido: `${updated.rowCount} rows affected`,
      pass: updated.rowCount === 0,
      detalhe:
        updated.rowCount === 0
          ? "negado por 0 linhas afetadas (USING oculta a linha)"
          : "VIOLAÇÃO: linha da outra tenant foi mutável",
    });
  } catch (error) {
    probes.push({
      ...denialFromError(error),
      probe: "b-update-products-b",
      operacao: `UPDATE products ... id = <product ${other.slug}>`,
    });
  }

  // (c) INSERT cross-tenant
  try {
    const inserted = await inSavepoint(() =>
      query(
        `insert into products (id, tenant_id, user_id, name)
         values ($1, $2, $3, 'rls-probe cross-tenant insert')`,
        [randomUUID(), other.id, otherUserId],
      ),
    );
    probes.push({
      probe: "c-insert-products-b",
      operacao: `INSERT INTO products ... tenant_id = ${other.slug}`,
      esperado: "erro de policy (ou 0 rows)",
      obtido: `${inserted.rowCount} rows inserted`,
      pass: inserted.rowCount === 0,
      detalhe:
        inserted.rowCount === 0
          ? "negado (0 linhas inseridas)"
          : "VIOLAÇÃO: insert cross-tenant aceito",
    });
  } catch (error) {
    probes.push({
      ...denialFromError(error),
      probe: "c-insert-products-b",
      operacao: `INSERT INTO products ... tenant_id = ${other.slug}`,
    });
  }

  // (d) leitura cross-tenant de users da outra tenant, via caminho tenant-scoped
  // com SELECT concedido a app_runtime: tenant_memberships (RLS própria).
  const usersViaMemberships = await query(
    `select count(*)::bigint as n
       from users u
       join tenant_memberships m on m.user_id = u.id
      where m.tenant_id = $1`,
    [other.id],
  );
  probes.push({
    probe: "d-leitura-users-b-via-memberships",
    operacao: `SELECT count(*) FROM users JOIN tenant_memberships ... WHERE tenant_memberships.tenant_id = ${other.slug}`,
    esperado: 0,
    obtido: Number(usersViaMemberships.rows[0].n),
    pass: Number(usersViaMemberships.rows[0].n) === 0,
    detalhe:
      "identidades da outra tenant só são alcançáveis via tabela tenant-scoped; " +
      "RLS de tenant_memberships (user_id = current_user_id) deve ocultar",
  });

  // (obs2) caminho alternativo via profiles: app_runtime é INSERT-only em
  // profiles (design migration 0001 — sem SELECT), logo a negação esperada é
  // por grant (42501) ou, se grants mudarem, por RLS (0 rows).
  try {
    const usersViaProfiles = await inSavepoint(() =>
      query(
        `select count(*)::bigint as n
           from users u
           join profiles p on p.id = u.id
          where p.tenant_id = $1`,
        [other.id],
      ),
    );
    probes.push({
      probe: "obs2-leitura-users-b-via-profiles",
      operacao: `SELECT count(*) FROM users JOIN profiles ... WHERE profiles.tenant_id = ${other.slug}`,
      esperado: "negado (0 rows ou erro 42501)",
      obtido: `${Number(usersViaProfiles.rows[0].n)} rows`,
      pass: Number(usersViaProfiles.rows[0].n) === 0,
      detalhe:
        "observação complementar: negação por RLS de profiles (0 rows) — profiles deveria " +
        "estar com SELECT concedido",
    });
  } catch (error) {
    const code = error?.code ?? "DESCONHECIDO";
    probes.push({
      probe: "obs2-leitura-users-b-via-profiles",
      operacao: `SELECT count(*) FROM users JOIN profiles ... WHERE profiles.tenant_id = ${other.slug}`,
      esperado: "negado (0 rows ou erro 42501)",
      obtido: `erro ${code}${isPolicyError(error) ? " (policy RLS)" : ""}`,
      pass: code === "42501" || isPolicyError(error),
      detalhe:
        code === "42501"
          ? "observação complementar: negação por grant — profiles é INSERT-only para " +
            "app_runtime (design migration 0001); leitura de perfis da outra tenant é bloqueada"
          : "observação complementar: negação por exceção NÃO esperada (analisar código)",
      erro: dbErrorSummary(error),
    });
  }

  return probes;
}

/** Observação documentada: leitura DIRETA de users é tabela global better-auth
 * (sem tenant_id, sem RLS — fora do escopo "tabelas tenant" do H-07). */
async function usersGlobalObservation(query) {
  const direct = await query(`select count(*)::bigint as n from users where id = $1`, [USER_B_ID]);
  return {
    probe: "obs-leitura-direta-users-b",
    operacao: "SELECT count(*) FROM users WHERE id = <user B> (leitura direta)",
    esperado: 1,
    obtido: Number(direct.rows[0].n),
    pass: Number(direct.rows[0].n) === 1,
    detalhe:
      "observação (não é probe de negação): users é tabela global better-auth sem tenant_id/RLS " +
      "(fora do escopo 'tabelas tenant' do H-07); leitura direta por id é by-design e a " +
      "descoberta cross-tenant é bloqueada (probe d e obs2). Esperado=1 registra o design.",
  };
}

// ---------------------------------------------------------------------------
// Fase CATÁLOGO
// ---------------------------------------------------------------------------

async function catalogPhase(query) {
  const roles = await query(
    `select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin
       from pg_roles
      where rolname in ('app_runtime', 'neondb_owner')
      order by rolname`,
  );
  const appRuntime = roles.rows.find((row) => row.rolname === "app_runtime");
  const ownerRole = roles.rows.find((row) => row.rolname === "neondb_owner");
  const tenantTables = await query(
    `select c.relname as table_name,
            c.relrowsecurity as row_security,
            pg_get_userbyid(c.relowner) as table_owner
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and (
          c.relname in ('tenants', 'tenant_memberships')
          or exists (
            select 1 from information_schema.columns col
             where col.table_schema = n.nspname
               and col.table_name = c.relname
               and col.column_name = 'tenant_id'
          )
        )
      order by c.relname`,
  );
  const tables = tenantTables.rows.map((row) => ({
    table: row.table_name,
    row_security: row.row_security,
    table_owner: row.table_owner,
    rls_ok: row.row_security === true,
    owner_ok: row.table_owner !== "app_runtime",
  }));
  const policyCount = await query(
    `select count(*)::bigint as n
       from pg_policy pol
       join pg_class c on c.oid = pol.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'`,
  );
  return {
    app_runtime: {
      rolsuper: appRuntime?.rolsuper ?? null,
      rolbypassrls: appRuntime?.rolbypassrls ?? null,
      rolinherit: appRuntime?.rolinherit ?? null,
      rolcanlogin: appRuntime?.rolcanlogin ?? null,
      ok: appRuntime?.rolsuper === false && appRuntime?.rolbypassrls === false,
    },
    neondb_owner_observacao: {
      rolsuper: ownerRole?.rolsuper ?? null,
      rolbypassrls: ownerRole?.rolbypassrls ?? null,
      nota: "owner/admin: rolbypassrls = true é esperado (sonda 0.3, fase0-2026-09-06)",
    },
    tenant_tables: tables,
    policy_count: Number(policyCount.rows[0].n),
    ok:
      appRuntime?.rolsuper === false &&
      appRuntime?.rolbypassrls === false &&
      tables.every((table) => table.rls_ok && table.owner_ok),
  };
}

// ---------------------------------------------------------------------------
// Cleanup (--cleanup): apaga o seed por ids fixos e verifica contagens
// ---------------------------------------------------------------------------

async function cleanupPhase(client) {
  await client.query(`delete from products where id = any($1::uuid[])`, [
    [PRODUCT_A_ID, PRODUCT_B_ID],
  ]);
  await client.query(
    `delete from tenant_memberships where (tenant_id, user_id) in (($1, $2), ($3, $4))`,
    [TENANT_A.id, USER_A_ID, TENANT_B.id, USER_B_ID],
  );
  await client.query(`delete from users where id = any($1::text[])`, [[USER_A_ID, USER_B_ID]]);
  await client.query(`delete from tenants where id = any($1::uuid[])`, [
    [TENANT_A.id, TENANT_B.id],
  ]);
  const residual = await client.query(
    `select
       (select count(*)::bigint as n from tenants where id = any($1::uuid[])
          or slug in ($5, $6)) as tenants,
       (select count(*)::bigint as n from users where id = any($2::text[])
          or email like '%@preco-que-da.test') as users,
       (select count(*)::bigint as n from products where id = any($3::uuid[])) as products,
       (select count(*)::bigint as n from tenant_memberships
          where (tenant_id, user_id) in (($1, $2), ($4, $7))) as memberships`,
    [TENANT_A.id, USER_A_ID, PRODUCT_A_ID, TENANT_B.id, TENANT_A.slug, TENANT_B.slug, USER_B_ID],
  );
  const row = residual.rows[0];
  const after = {
    tenants: Number(row.tenants),
    users: Number(row.users),
    products: Number(row.products),
    memberships: Number(row.memberships),
  };
  const ok = Object.values(after).every((value) => value === 0);
  return { executed: true, after, ok };
}

// ---------------------------------------------------------------------------
// Evidência
// ---------------------------------------------------------------------------

function renderMarkdown(report) {
  const lines = [];
  lines.push(
    `# Sonda RLS H-07 (residual §42) — rls-probe ${report.meta.generated_at.slice(0, 10)}`,
  );
  lines.push("");
  lines.push(`- gerado_em: ${report.meta.generated_at}`);
  lines.push(`- target_env: \`${report.meta.target_env}\` (valor da URL omitido por norma)`);
  lines.push(
    `- alvo: ${report.meta.target.host} · database \`${report.meta.target.database}\` · role \`${report.meta.target.role}\``,
  );
  lines.push(`- resultado: **${report.result}** (exit ${report.meta.exit_code})`);
  lines.push(
    "- método: seed por parâmetros vinculados (ids fixos) → transação `SET ROLE app_runtime` + " +
      "`set_config(..., true)` com rollback garantido → tentativas cross-tenant A→B e B→A → catálogo read-only",
  );
  lines.push("");
  lines.push("## Seed (única escrita sancionada)");
  lines.push("");
  lines.push(`- ids fixos registrados: tenants \`${report.seed.ids.tenants.join("`, `")}\``);
  lines.push(
    `- users: \`${report.seed.ids.users.join("`, `")}\` (${report.seed.emails.join(", ")})`,
  );
  lines.push(`- products: \`${report.seed.ids.products.join("`, `")}\``);
  lines.push(
    `- membership admin→app_runtime (SET OPTION): before=${report.seed.membership.set_option_before} after=${report.seed.membership.set_option_after} criada_pelo_probe=${report.seed.membership.created_by_probe}`,
  );
  lines.push(`- contagens pós-seed: ${JSON.stringify(report.seed.counts)} (ok=${report.seed.ok})`);
  lines.push(`- cleanup: ${report.seed.cleanup}`);
  lines.push("");
  lines.push("## Probes (contexto app_runtime personificado, transação com rollback)");
  lines.push("");
  lines.push("| sessão | probe | operação | esperado | obtido | pass | detalhe |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const session of report.sessions) {
    for (const probe of session.probes) {
      lines.push(
        `| ${session.label} | ${probe.probe} | ${probe.operacao} | ${String(probe.esperado)} | ${String(probe.obtido)} | ${probe.pass ? "SIM" : "**NÃO**"} | ${probe.detalhe} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Catálogo (read-only, §11.9/§32)");
  lines.push("");
  lines.push(
    `- app_runtime: rolsuper=${report.catalog.app_runtime.rolsuper} rolbypassrls=${report.catalog.app_runtime.rolbypassrls} (ok=${report.catalog.app_runtime.ok})`,
  );
  lines.push(
    `- neondb_owner (observação): rolsuper=${report.catalog.neondb_owner_observacao.rolsuper} rolbypassrls=${report.catalog.neondb_owner_observacao.rolbypassrls} — ${report.catalog.neondb_owner_observacao.nota}`,
  );
  lines.push(
    `- tabelas tenant (RLS + owner ≠ app_runtime): ${report.catalog.tenant_tables.length} verificadas, ok=${report.catalog.ok}`,
  );
  const catalogFailures = report.catalog.tenant_tables.filter(
    (table) => !table.rls_ok || !table.owner_ok,
  );
  for (const failure of catalogFailures) {
    lines.push(
      `  - FALHA: ${failure.table} rls=${failure.row_security} owner=${failure.table_owner}`,
    );
  }
  lines.push(`- policies em tabelas public: ${report.catalog.policy_count}`);
  lines.push("");
  lines.push("## Notas de execução");
  lines.push("");
  for (const note of report.meta.notas) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push(`- JSON companheiro: \`${report.meta.json_path}\``);
  lines.push(`- sha256 do JSON: \`${report.meta.json_sha256}\``);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`rls-probe: ${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const url = envUrl(parsed.targetEnv);
  if (!url) {
    process.stderr.write(
      `rls-probe: erro de ambiente (fail-closed): variável ${parsed.targetEnv} ausente/vazia (valor nunca impresso)\n`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    validateTarget(url, parsed.targetEnv);
  } catch (error) {
    process.stderr.write(
      `rls-probe: erro de ambiente (fail-closed): ${error instanceof Error ? error.message : "alvo invalido"}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const target = maskedTarget(url);
  const client = makeClient(url);
  const startedAt = new Date().toISOString();
  const notes = [
    "URL de conexão obtida e consumida em-processo (nunca em argv, nunca impressa; incidente SASL/SSL do V2: substitution multi-linha do shell chega vazia — padrão in-process mantido).",
    "Invocação remota somente pelo npm script sancionado com hook env-guard; o alvo remoto desta rodada é DATABASE_RESTORE_URL em branch drill, nunca production.",
    "Cleanup do seed (sem --cleanup) é delegado à deleção da branch inteira no V4 (§12.5 always()); com --cleanup o seed é apagado e verificado ao final.",
    "Membership do admin (neondb_owner) em app_runtime com SET OPTION é garantida pelo seed desta sonda (idempotente) na branch efêmera; nenhuma membership de produção é alterada nesta modalidade.",
    "users é tabela global better-auth (sem tenant_id, sem RLS — fora do escopo 'tabelas tenant' do H-07): a leitura cross-tenant de identidades é probe d via tenant_memberships (SELECT+RLS) e obs2 via profiles (INSERT-only por grant, migration 0001).",
  ];

  try {
    await client.connect();

    // ---- SEED -------------------------------------------------------------
    let seed;
    try {
      seed = await seedPhase(client);
    } catch (error) {
      process.stderr.write(
        `rls-probe: falha na fase SEED: ${JSON.stringify(dbErrorSummary(error))}\n`,
      );
      process.exitCode = 2;
      return;
    }

    // ---- PROBE ------------------------------------------------------------
    let sessions;
    try {
      const sessionA = await probeSession(
        client,
        "A (probe-a-tenant)",
        USER_A_ID,
        TENANT_A.id,
        (query) =>
          crossTenantProbes(query, TENANT_B, USER_B_ID, PRODUCT_B_ID).then(async (probes) => [
            ...probes,
            await usersGlobalObservation(query),
          ]),
      );
      const sessionB = await probeSession(
        client,
        "B (probe-b-tenant)",
        USER_B_ID,
        TENANT_B.id,
        (query) => crossTenantProbes(query, TENANT_A, USER_A_ID, PRODUCT_A_ID),
      );
      sessions = [sessionA, sessionB];
    } catch (error) {
      process.stderr.write(
        `rls-probe: falha na fase PROBE: ${JSON.stringify(dbErrorSummary(error))}\n`,
      );
      process.exitCode = 2;
      return;
    }

    // ---- CATÁLOGO ---------------------------------------------------------
    let catalog;
    try {
      catalog = await catalogPhase((text, params = []) => client.query(text, params));
    } catch (error) {
      process.stderr.write(
        `rls-probe: falha na fase CATÁLOGO: ${JSON.stringify(dbErrorSummary(error))}\n`,
      );
      process.exitCode = 2;
      return;
    }

    // ---- CLEANUP (opcional) -----------------------------------------------
    let cleanup;
    if (parsed.cleanup) {
      try {
        cleanup = await cleanupPhase(client);
      } catch (error) {
        process.stderr.write(
          `rls-probe: falha na fase CLEANUP: ${JSON.stringify(dbErrorSummary(error))}\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (!cleanup.ok) {
        process.stderr.write(
          `rls-probe: verificação pós-cleanup com resíduo: ${JSON.stringify(cleanup.after)}\n`,
        );
        process.exitCode = 2;
        return;
      }
    }
    const cleanupNote = cleanup
      ? `executado nesta execução (--cleanup); contagens pós-cleanup = ${JSON.stringify(cleanup.after)} (ok=${cleanup.ok})`
      : "não deletado por padrão — branch efêmera deletada inteira no V4 (§12.5 always()); " +
        "no dia do cutover contra produção, re-executar com --cleanup para apagar e verificar o seed";

    // ---- Classificação ----------------------------------------------------
    const probes = sessions.flatMap((session) => session.probes);
    const denialProbes = probes.filter((probe) => !probe.probe.startsWith("obs"));
    const observationProbes = probes.filter((probe) => probe.probe.startsWith("obs"));
    const leaks = denialProbes.filter((probe) => !probe.pass);
    const observationFailures = observationProbes.filter((probe) => !probe.pass);
    const violation = leaks.length > 0 || !catalog.ok || !seed.ok;
    const result = violation ? "VIOLATION" : observationFailures.length > 0 ? "ERROR" : "PASS";
    const exitCode = violation ? 4 : observationFailures.length > 0 ? 2 : 0;

    const report = {
      script: "rls-probe",
      result,
      meta: {
        generated_at: startedAt,
        target_env: parsed.targetEnv,
        target,
        design: "docs/runbooks/a4-matriz-hipoteses.md — Design H-07 (m02:rls-probe)",
        executa_negacao_bidirecional: true,
        cleanup_flag: parsed.cleanup,
        exit_code: exitCode,
        json_path: "",
        json_sha256: "",
        notas: notes,
      },
      seed: { ...seed, cleanup: cleanupNote },
      sessions: sessions.map((session) => ({
        label: session.label,
        context: session.context,
        probes: session.probes,
      })),
      catalog,
      summary: {
        probes_total: probes.length,
        probes_negacao: denialProbes.length,
        probes_negacao_pass: denialProbes.filter((probe) => probe.pass).length,
        observacoes: observationProbes.length,
        observacoes_pass: observationProbes.filter((probe) => probe.pass).length,
        catalog_ok: catalog.ok,
        seed_ok: seed.ok,
        pass: !violation,
      },
    };

    const json = `${JSON.stringify(report, null, 2)}\n`;
    let outPath;
    if (parsed.out) {
      outPath = resolve(parsed.out);
      const jsonPath = outPath.replace(/\.md$/, ".json");
      report.meta.json_path = jsonPath;
      report.meta.json_sha256 = createHash("sha256").update(json).digest("hex");
      const markdown = renderMarkdown(report);
      writeFileSync(outPath, markdown);
      writeFileSync(jsonPath, json);
    }

    if (violation || observationFailures.length > 0) {
      const detalhes = {
        result,
        alvo: target,
        vazamentos: leaks.length > 0 ? leaks : null,
        anomalias_observacao: observationFailures.length > 0 ? observationFailures : null,
        catalog_ok: catalog.ok,
        seed_ok: seed.ok,
        probes: probes,
      };
      process.stdout.write(`${JSON.stringify(detalhes)}\n`);
      process.exitCode = violation ? 4 : 2;
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        script: "rls-probe",
        result,
        target_env: parsed.targetEnv,
        alvo: target,
        probes_negacao: report.summary.probes_negacao,
        probes_negacao_pass: report.summary.probes_negacao_pass,
        catalog_ok: catalog.ok,
        cleanup: cleanup ? "executado e verificado" : "delegado à deleção da branch (V4)",
        out: parsed.out ?? null,
        json_sha256: report.meta.json_sha256 || null,
      })}\n`,
    );
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `rls-probe: erro de conexão/banco (fail-closed): ${JSON.stringify(dbErrorSummary(error))}\n`,
    );
    process.exitCode = 2;
  } finally {
    try {
      await client.end();
    } catch {
      // conexão já encerrada; nada a fazer
    }
  }
}

await main();
