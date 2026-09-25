import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import Decimal from "decimal.js";
import { Pool, type PoolClient } from "pg";
import { reconcileMigration } from "./reconcile";

type JsonObject = Record<string, unknown>;

interface LegacyUser {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  raw_user_meta_data: JsonObject | null;
  created_at: Date;
  updated_at: Date;
}

interface LegacyProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  created_at: Date;
}

interface LegacyIdentity {
  id: string;
  user_id: string;
  provider: string;
  identity_data: JsonObject | null;
  created_at: Date;
  updated_at: Date;
}

interface LegacyProduct {
  id: string;
  user_id: string;
  name: string;
  current_price: string | null;
  yield_qty: string | null;
  yield_unit: string | null;
  tax_regime: string | null;
  tax_rate: string | null;
  is_demo: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LegacyIngredient {
  id: string;
  product_id: string;
  user_id: string;
  name: string;
  used_qty: string;
  used_unit: string;
  package_price: string | null;
  package_qty: string | null;
  package_unit: string | null;
  price_updated_at: Date | null;
  created_at: Date;
}

interface LegacyPackaging {
  id: string;
  product_id: string;
  user_id: string;
  name: string;
  package_price: string;
  units_per_package: string;
  price_updated_at: Date | null;
  created_at: Date;
}

interface LegacyFee {
  id: string;
  product_id: string;
  user_id: string;
  name: string;
  percentage: string;
  created_at: Date;
}

interface LegacyMarketPrice {
  id: string;
  product_id: string;
  user_id: string;
  min_price: string | null;
  avg_price: string | null;
  max_price: string | null;
  created_at: Date;
}

interface LegacyExpense {
  id: string;
  user_id: string;
  name: string;
  category: string | null;
  amount: string;
  type: string;
  periodicity: string;
  is_demo: boolean;
  notes: string | null;
  created_at: Date;
}

interface LegacySimulation {
  id: string;
  user_id: string;
  product_id: string | null;
  name: string;
  params: JsonObject;
  created_at: Date;
}

interface LegacyMessage {
  id: string;
  user_id: string;
  role: string;
  content: string;
  metadata: JsonObject | null;
  created_at: Date;
}

function requireUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não configurada`);
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} deve ser uma URL PostgreSQL`);
  }
  return value;
}

function deterministicUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 32);
  const chars = [...hex];
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const normalized = chars.join("");
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function decimal(value: string | null, scale: number): string | null {
  if (value == null) return null;
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error("Decimal não finito na origem");
  return result.toFixed(scale, Decimal.ROUND_HALF_UP);
}

function fraction(value: string | null): string | null {
  if (value == null) return null;
  return new Decimal(value).div(100).toFixed(6, Decimal.ROUND_HALF_UP);
}

function stringMetadata(value: JsonObject | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

async function rows<T extends object>(client: PoolClient, query: string): Promise<T[]> {
  return (await client.query<T>(query)).rows;
}

async function assertSourceIntegrity(source: PoolClient): Promise<void> {
  const readOnly = await source.query<{ transaction_read_only: string }>(
    "show transaction_read_only",
  );
  if (readOnly.rows[0]?.transaction_read_only !== "on") {
    throw new Error("A conexão de origem não está em transação read-only");
  }
  const [missingEmail, ownershipMismatch] = await Promise.all([
    source.query<{ count: string }>(
      "select count(*)::text as count from auth.users where email is null",
    ),
    source.query<{ count: string }>(`
      select count(*)::text as count from (
        select c.id from public.product_ingredients c join public.products p on p.id = c.product_id where c.user_id <> p.user_id
        union all select c.id from public.product_packaging c join public.products p on p.id = c.product_id where c.user_id <> p.user_id
        union all select c.id from public.sales_fees c join public.products p on p.id = c.product_id where c.user_id <> p.user_id
        union all select c.id from public.market_prices c join public.products p on p.id = c.product_id where c.user_id <> p.user_id
      ) inconsistent
    `),
  ]);
  if (Number(missingEmail.rows[0]?.count ?? 0) > 0) {
    throw new Error("Existem usuários sem e-mail; documente a exceção antes de migrar");
  }
  if (Number(ownershipMismatch.rows[0]?.count ?? 0) > 0) {
    throw new Error("Existem filhos cujo user_id diverge do proprietário do produto");
  }
}

async function importUsers(source: PoolClient, target: PoolClient): Promise<Map<string, string>> {
  const [users, profiles, identities] = await Promise.all([
    rows<LegacyUser>(
      source,
      `select id::text, email, encrypted_password, email_confirmed_at,
      raw_user_meta_data, created_at, updated_at from auth.users order by id`,
    ),
    rows<LegacyProfile>(
      source,
      "select id::text, email, display_name, created_at from public.profiles order by id",
    ),
    rows<LegacyIdentity>(
      source,
      `select id::text, user_id::text, provider, identity_data,
      created_at, updated_at from auth.identities order by id`,
    ),
  ]);
  const profileByUser = new Map(profiles.map((profile) => [profile.id, profile]));
  const tenantByUser = new Map<string, string>();

  for (const user of users) {
    if (!user.email) throw new Error(`Usuário ${user.id} sem e-mail`);
    const profile = profileByUser.get(user.id);
    const rawName =
      stringMetadata(user.raw_user_meta_data, "full_name") ??
      stringMetadata(user.raw_user_meta_data, "name");
    const name = profile?.display_name ?? rawName ?? user.email.split("@", 1)[0] ?? "Usuário";
    const tenantId = deterministicUuid("personal-tenant", user.id);
    tenantByUser.set(user.id, tenantId);
    await target.query(
      `insert into users (id, name, email, email_verified, image, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set name=excluded.name, email=excluded.email,
         email_verified=excluded.email_verified, image=excluded.image, updated_at=excluded.updated_at`,
      [
        user.id,
        name,
        user.email,
        Boolean(user.email_confirmed_at),
        stringMetadata(user.raw_user_meta_data, "avatar_url"),
        user.created_at,
        user.updated_at,
      ],
    );
    await target.query(
      `insert into tenants (id, name, slug, kind, created_at, updated_at)
       values ($1,$2,$3,'personal',$4,$5)
       on conflict (id) do update set name=excluded.name, updated_at=excluded.updated_at`,
      [tenantId, name, `personal-${user.id}`, user.created_at, user.updated_at],
    );
    await target.query(
      `insert into tenant_memberships (tenant_id, user_id, role, created_at, updated_at)
       values ($1,$2,'owner',$3,$4)
       on conflict (tenant_id,user_id) do update set role='owner', updated_at=excluded.updated_at`,
      [tenantId, user.id, user.created_at, user.updated_at],
    );
    await target.query(
      `insert into profiles (id, tenant_id, user_id, email, display_name, created_at, updated_at)
       values ($1,$2,$1,$3,$4,$5,$6)
       on conflict (id) do update set tenant_id=excluded.tenant_id, user_id=excluded.user_id,
         email=excluded.email, display_name=excluded.display_name, updated_at=excluded.updated_at`,
      [
        user.id,
        tenantId,
        profile?.email ?? user.email,
        profile?.display_name ?? name,
        profile?.created_at ?? user.created_at,
        user.updated_at,
      ],
    );
    if (user.encrypted_password?.trim()) {
      await target.query(
        `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values ($1,$2,'credential',$2,$3,$4,$5)
         on conflict (provider_id,account_id) do update set password=excluded.password, updated_at=excluded.updated_at`,
        [
          `credential:${user.id}`,
          user.id,
          user.encrypted_password,
          user.created_at,
          user.updated_at,
        ],
      );
    }
    await target.query(
      `insert into chat_conversations (id, tenant_id, user_id, confirmed_state, created_at, updated_at)
       values ($1,$2,$3,'{}'::jsonb,$4,$5)
       on conflict (tenant_id,user_id) do nothing`,
      [
        deterministicUuid("conversation", user.id),
        tenantId,
        user.id,
        user.created_at,
        user.updated_at,
      ],
    );
  }

  for (const identity of identities) {
    if (identity.provider === "email") continue;
    const accountId = stringMetadata(identity.identity_data, "sub") ?? identity.id;
    await target.query(
      `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (provider_id,account_id) do update set user_id=excluded.user_id, updated_at=excluded.updated_at`,
      [
        `identity:${identity.id}`,
        accountId,
        identity.provider,
        identity.user_id,
        identity.created_at,
        identity.updated_at,
      ],
    );
  }
  return tenantByUser;
}

function tenantFor(tenantByUser: Map<string, string>, userId: string): string {
  const tenantId = tenantByUser.get(userId);
  if (!tenantId) throw new Error(`Tenant não encontrado para usuário ${userId}`);
  return tenantId;
}

async function importBusinessData(
  source: PoolClient,
  target: PoolClient,
  tenantByUser: Map<string, string>,
): Promise<void> {
  const products = await rows<LegacyProduct>(
    source,
    `select id::text, user_id::text, name,
    current_price::text, yield_qty::text, yield_unit, tax_regime, tax_rate::text,
    is_demo, notes, created_at, updated_at from public.products order by id`,
  );
  for (const row of products) {
    await target.query(
      `insert into products (id,tenant_id,user_id,name,current_price,yield_qty,yield_unit,tax_regime,tax_rate,is_demo,notes,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,name=excluded.name,
         current_price=excluded.current_price,yield_qty=excluded.yield_qty,yield_unit=excluded.yield_unit,
         tax_regime=excluded.tax_regime,tax_rate=excluded.tax_rate,is_demo=excluded.is_demo,notes=excluded.notes,updated_at=excluded.updated_at`,
      [
        row.id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        row.name,
        decimal(row.current_price, 4),
        decimal(row.yield_qty, 6),
        row.yield_unit,
        row.tax_regime,
        fraction(row.tax_rate),
        row.is_demo,
        row.notes,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  const ingredients = await rows<LegacyIngredient>(
    source,
    `select id::text,product_id::text,user_id::text,name,
    used_qty::text,used_unit,package_price::text,package_qty::text,package_unit,price_updated_at,created_at
    from public.product_ingredients order by id`,
  );
  for (const row of ingredients) {
    await target.query(
      `insert into product_ingredients (id,product_id,tenant_id,user_id,name,used_qty,used_unit,package_price,package_qty,package_unit,price_updated_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,name=excluded.name,
         used_qty=excluded.used_qty,used_unit=excluded.used_unit,package_price=excluded.package_price,
         package_qty=excluded.package_qty,package_unit=excluded.package_unit,price_updated_at=excluded.price_updated_at,updated_at=excluded.updated_at`,
      [
        row.id,
        row.product_id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        row.name,
        decimal(row.used_qty, 6),
        row.used_unit,
        decimal(row.package_price, 4),
        decimal(row.package_qty, 6),
        row.package_unit,
        row.price_updated_at,
        row.created_at,
      ],
    );
  }

  const packaging = await rows<LegacyPackaging>(
    source,
    `select id::text,product_id::text,user_id::text,name,
    package_price::text,units_per_package::text,price_updated_at,created_at from public.product_packaging order by id`,
  );
  for (const row of packaging) {
    await target.query(
      `insert into product_packaging (id,product_id,tenant_id,user_id,name,package_price,units_per_package,price_updated_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,name=excluded.name,
         package_price=excluded.package_price,units_per_package=excluded.units_per_package,price_updated_at=excluded.price_updated_at,updated_at=excluded.updated_at`,
      [
        row.id,
        row.product_id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        row.name,
        decimal(row.package_price, 4),
        decimal(row.units_per_package, 6),
        row.price_updated_at,
        row.created_at,
      ],
    );
  }

  const fees = await rows<LegacyFee>(
    source,
    "select id::text,product_id::text,user_id::text,name,percentage::text,created_at from public.sales_fees order by id",
  );
  for (const row of fees) {
    await target.query(
      `insert into sales_fees (id,product_id,tenant_id,user_id,name,percentage,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$7)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,name=excluded.name,percentage=excluded.percentage,updated_at=excluded.updated_at`,
      [
        row.id,
        row.product_id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        row.name,
        fraction(row.percentage),
        row.created_at,
      ],
    );
  }

  const market = await rows<LegacyMarketPrice>(
    source,
    `select id::text,product_id::text,user_id::text,
    min_price::text,avg_price::text,max_price::text,created_at from public.market_prices order by id`,
  );
  for (const row of market) {
    await target.query(
      `insert into market_prices (id,product_id,tenant_id,user_id,min_price,avg_price,max_price,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,min_price=excluded.min_price,avg_price=excluded.avg_price,max_price=excluded.max_price`,
      [
        row.id,
        row.product_id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        decimal(row.min_price, 4),
        decimal(row.avg_price, 4),
        decimal(row.max_price, 4),
        row.created_at,
      ],
    );
  }

  const expenses = await rows<LegacyExpense>(
    source,
    `select id::text,user_id::text,name,category,amount::text,
    type,periodicity,is_demo,notes,created_at from public.expenses order by id`,
  );
  for (const row of expenses) {
    await target.query(
      `insert into expenses (id,tenant_id,user_id,name,category,amount,type,periodicity,is_demo,notes,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,name=excluded.name,
         category=excluded.category,amount=excluded.amount,type=excluded.type,periodicity=excluded.periodicity,is_demo=excluded.is_demo,notes=excluded.notes,updated_at=excluded.updated_at`,
      [
        row.id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        row.name,
        row.category,
        decimal(row.amount, 4),
        row.type,
        row.periodicity,
        row.is_demo,
        row.notes,
        row.created_at,
      ],
    );
  }

  const simulations = await rows<LegacySimulation>(
    source,
    "select id::text,user_id::text,product_id::text,name,params,created_at from public.simulations order by id",
  );
  for (const row of simulations) {
    await target.query(
      `insert into simulations (id,tenant_id,user_id,product_id,name,params,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$7)
       on conflict (id) do update set tenant_id=excluded.tenant_id,user_id=excluded.user_id,product_id=excluded.product_id,name=excluded.name,params=excluded.params,updated_at=excluded.updated_at`,
      [
        row.id,
        tenantFor(tenantByUser, row.user_id),
        row.user_id,
        row.product_id,
        row.name,
        row.params,
        row.created_at,
      ],
    );
  }
}

async function importChat(
  source: PoolClient,
  target: PoolClient,
  tenantByUser: Map<string, string>,
): Promise<void> {
  const messages = await rows<LegacyMessage>(
    source,
    "select id::text,user_id::text,role,content,metadata,created_at from public.chat_messages order by created_at,id",
  );
  const productIds = new Set(
    (await target.query<{ id: string }>("select id::text from products")).rows.map((row) => row.id),
  );
  const lastState = new Map<string, { productId: string | null; messageId: string; at: Date }>();
  for (const row of messages) {
    if (!["user", "assistant", "system", "tool"].includes(row.role)) {
      throw new Error(`Role de chat inválida em ${row.id}`);
    }
    const tenantId = tenantFor(tenantByUser, row.user_id);
    const conversationId = deterministicUuid("conversation", row.user_id);
    await target.query(
      `insert into chat_messages (id,conversation_id,tenant_id,user_id,role,content,metadata,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set conversation_id=excluded.conversation_id,tenant_id=excluded.tenant_id,
         user_id=excluded.user_id,role=excluded.role,content=excluded.content,metadata=excluded.metadata`,
      [
        row.id,
        conversationId,
        tenantId,
        row.user_id,
        row.role,
        row.content,
        row.metadata,
        row.created_at,
      ],
    );
    const candidate =
      stringMetadata(row.metadata, "current_product_id") ??
      stringMetadata(row.metadata, "currentProductId");
    lastState.set(row.user_id, {
      productId: candidate && productIds.has(candidate) ? candidate : null,
      messageId: row.id,
      at: row.created_at,
    });
  }
  for (const [userId, state] of lastState) {
    await target.query(
      `update chat_conversations set current_product_id=$1, confirmed_state=$2, updated_at=$3
       where tenant_id=$4 and user_id=$5`,
      [
        state.productId,
        {
          currentProductId: state.productId,
          lastAssistantMessageId: state.messageId,
          lastConfirmedAt: state.at.toISOString(),
        },
        state.at,
        tenantFor(tenantByUser, userId),
        userId,
      ],
    );
  }
}

async function main(): Promise<void> {
  const sourceUrl = requireUrl("SUPABASE_MIGRATION_DATABASE_URL");
  const targetUrl = requireUrl("DATABASE_ADMIN_URL");
  if (new URL(sourceUrl).host === new URL(targetUrl).host) {
    throw new Error("Origem e destino não podem apontar para o mesmo host");
  }
  const sourcePool = new Pool({ connectionString: sourceUrl, max: 1 });
  const targetPool = new Pool({ connectionString: targetUrl, max: 1 });
  const source = await sourcePool.connect();
  const target = await targetPool.connect();
  const apply = process.env.MIGRATION_APPLY === "true";
  try {
    await source.query("begin isolation level repeatable read read only");
    await target.query("begin isolation level serializable");
    await target.query("select pg_advisory_xact_lock(hashtext('preco-que-da-lucro:p0-migration'))");
    await assertSourceIntegrity(source);
    const targetState = await target.query<{ count: string }>(
      "select count(*)::text as count from users",
    );
    if (
      Number(targetState.rows[0]?.count ?? 0) > 0 &&
      process.env.MIGRATION_ALLOW_UPSERT !== "true"
    ) {
      throw new Error(
        "Destino não está vazio; use MIGRATION_ALLOW_UPSERT=true somente após revisão",
      );
    }
    const tenantByUser = await importUsers(source, target);
    await importBusinessData(source, target, tenantByUser);
    await importChat(source, target, tenantByUser);
    const reconciliation = await reconcileMigration(source, target);
    const report = {
      ...reconciliation,
      applied: apply,
      sessionsImported: 0,
      sourceMode: "read-only-repeatable-read",
    };
    if (reconciliation.totals.different > 0) {
      throw new Error(
        `Reconciliação encontrou ${reconciliation.totals.different} tabela(s) diferente(s)`,
      );
    }
    if (apply) await target.query("commit");
    else await target.query("rollback");
    await source.query("rollback");
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env.MIGRATION_REPORT_PATH) {
      await writeFile(process.env.MIGRATION_REPORT_PATH, encoded, { mode: 0o600 });
    }
    process.stdout.write(encoded);
  } catch (error) {
    await Promise.allSettled([source.query("rollback"), target.query("rollback")]);
    throw error;
  } finally {
    source.release();
    target.release();
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

await main();
