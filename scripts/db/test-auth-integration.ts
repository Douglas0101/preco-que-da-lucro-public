import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hashSync } from "bcryptjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "../../src/db/schema";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import { createAuthInstance } from "../../src/server/auth/auth.server";
import {
  setEmailAdapterForTests,
  type AuthEmailMessage,
  type TransactionalEmailAdapter,
} from "../../src/server/email/email-adapter.server";
import { requireAdminUrl } from "./migrate";
import { MEMORY_TRAIL_TABLES } from "./purge-fixtures";

// TEST-NET (RFC 5737) addresses keep the Better Auth rate-limit buckets fully
// owned by this script. Every request carries an explicit x-forwarded-for so
// the shared "no-trusted-ip" bucket is never used for assertions, and cleanup
// below deletes only these prefixes plus stale no-trusted-ip counters —
// hermetic for repeated runs against the same database.
const SIGNUP_IP = "198.51.100.42";
// Maria signs up after the burst saturated SIGNUP_IP's 3/min bucket, so she
// needs her own bucket to stay deterministic.
const SIGNUP_IP_MARIA = "198.51.100.44";
const SIGNIN_IP = "198.51.100.43";
// §32 session fixation needs an attacker whose sign-in bucket is independent
// from the victim's, otherwise the two logins share the 5/min limit.
const ATTACKER_IP = "198.51.100.45";
const TEST_IPS = [SIGNUP_IP, SIGNUP_IP_MARIA, SIGNIN_IP, ATTACKER_IP] as const;
const TEST_EMAILS = [
  "burst-0@example.test",
  "burst-1@example.test",
  "burst-2@example.test",
  "burst-3@example.test",
  "maria@example.test",
  "legacy@example.test",
  "attacker@example.test",
] as const;
const LEGACY_USER_ID = "50000000-0000-4000-8000-000000000005";
const ATTACKER_USER_ID = "50000000-0000-4000-8000-000000000006";

// Better Auth >= 1.7.2 resolves credential accounts by
// createLocalAccountIssuer(providerId) === `local:${encodeURIComponent(id)}`.
// Raw-SQL account fixtures must carry that issuer or sign-in returns 401
// ("User not found"), independently of the connecting role.
const CREDENTIAL_ISSUER = "local:credential";

async function cleanupFixtures(admin: Client): Promise<void> {
  await admin.query(
    `delete from rate_limits
      where key like any($1::text[])`,
    [[...TEST_IPS.map((ip) => `${ip}|%`), "no-trusted-ip|%"]],
  );
  await admin.query(`delete from verifications where identifier = any($1::text[])`, [
    [...TEST_EMAILS],
  ]);
  // A trilha de memória precede o delete de users: `ai_memory_access_log` é
  // RESTRICT para memberships e bloquearia o cascade users -> memberships.
  for (const table of MEMORY_TRAIL_TABLES) {
    // pi-lens-ignore: no-sql-in-code
    await admin.query(
      `delete from ${table}
        where tenant_id in (
          select m.tenant_id from tenant_memberships m
          join users u on u.id = m.user_id
          where u.email = any($1::text[]) or u.id = $2
        )`,
      [[...TEST_EMAILS], LEGACY_USER_ID],
    );
  }
  // users cascades to accounts, sessions, tenant_memberships and profiles.
  await admin.query(`delete from users where email = any($1::text[])`, [[...TEST_EMAILS]]);
  await admin.query("delete from users where id = $1", [LEGACY_USER_ID]);
  await admin.query(
    `delete from tenants t
      where t.kind = 'personal' and t.slug like 'personal-%'
        and not exists (select 1 from tenant_memberships m where m.tenant_id = t.id)`,
  );
}

class CapturingEmailAdapter implements TransactionalEmailAdapter {
  verification?: AuthEmailMessage;
  reset?: AuthEmailMessage;

  async sendEmailVerification(message: AuthEmailMessage): Promise<void> {
    this.verification = message;
  }

  async sendPasswordReset(message: AuthEmailMessage): Promise<void> {
    this.reset = message;
  }
}

function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  cookie?: string,
  ipAddress?: string,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:3000",
    "sec-fetch-site": "same-origin",
  });
  if (cookie) headers.set("cookie", cookie);
  if (ipAddress) headers.set("x-forwarded-for", ipAddress);
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "login deve emitir Set-Cookie");
  assert.match(setCookie, /preco_que_da_lucro\.session_token=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.doesNotMatch(setCookie, /Domain=/i);
  return setCookie.split(";", 1)[0]!;
}

function cookieValue(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
}

async function sessionEmail(
  auth: ReturnType<typeof createAuthInstance>,
  cookie: string,
  ipAddress: string,
): Promise<string | undefined> {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/get-session?disableCookieCache=true", {
      headers: { cookie, "x-forwarded-for": ipAddress },
    }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user?: { email?: string } } | null;
  return body?.user?.email;
}

async function main(): Promise<void> {
  const runtimePassword = randomBytes(24).toString("base64url");
  const initialPassword = randomBytes(24).toString("base64url");
  const changedPassword = randomBytes(24).toString("base64url");
  const legacyPassword = randomBytes(24).toString("base64url");
  const attackerPassword = randomBytes(24).toString("base64url");
  const adminUrl = requireAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`alter role app_runtime password ${admin.escapeLiteral(runtimePassword)}`);

  const runtime = new URL(adminUrl);
  runtime.username = "app_runtime";
  runtime.password = runtimePassword;
  const pool = new Pool({ connectionString: runtime.toString(), max: 3 });
  const database = drizzle({ client: pool, schema });
  setDatabaseForTests(database as unknown as Database);

  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.AUTH_TRUSTED_ORIGINS = "http://localhost:3000";

  const email = new CapturingEmailAdapter();
  setEmailAdapterForTests(email);
  const auth = createAuthInstance(database as unknown as Database);
  const authReplica = createAuthInstance(database as unknown as Database);

  try {
    await cleanupFixtures(admin);
    const distributedBurst = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        (index % 2 === 0 ? auth : authReplica).handler(
          jsonRequest(
            "/sign-up/email",
            {
              name: `Burst ${index}`,
              email: `burst-${index}@example.test`,
              password: initialPassword,
            },
            undefined,
            SIGNUP_IP,
          ),
        ),
      ),
    );
    assert.equal(
      distributedBurst.filter((response) => response.status === 429).length,
      1,
      "o rate limit deve ser compartilhado e aplicado atomicamente entre instâncias",
    );
    const burstBucket = await admin.query<{ id: string; count: number; last_request: string }>(
      `select id, count, last_request::text as last_request
       from rate_limits where key = $1`,
      [`${SIGNUP_IP}|/sign-up/email`],
    );
    assert.equal(burstBucket.rowCount, 1);
    assert.ok(burstBucket.rows[0]?.id);
    assert.equal(burstBucket.rows[0]?.count, 3);
    assert.match(burstBucket.rows[0]?.last_request ?? "", /^\d+$/);

    const signup = await auth.handler(
      jsonRequest(
        "/sign-up/email",
        {
          name: "Maria Integração",
          email: "maria@example.test",
          password: initialPassword,
        },
        undefined,
        SIGNUP_IP_MARIA,
      ),
    );
    assert.equal(signup.status, 200);
    assert.ok(email.verification?.url);
    assert.equal(
      signup.headers.get("set-cookie"),
      null,
      "signup não autentica antes da confirmação",
    );

    const tenant = await admin.query<{ count: string }>(
      `select count(*)::text as count
       from tenants t
       join tenant_memberships m on m.tenant_id = t.id
       join users u on u.id = m.user_id
       where u.email = 'maria@example.test' and t.kind = 'personal' and m.role = 'owner'`,
    );
    assert.equal(tenant.rows[0]?.count, "1");

    const verificationUrl = new URL(email.verification.url);
    const verify = await auth.handler(
      new Request(verificationUrl, {
        headers: {
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
          "x-forwarded-for": SIGNIN_IP,
        },
        redirect: "manual",
      }),
    );
    assert.ok(verify.status >= 200 && verify.status < 400);

    const login = await auth.handler(
      jsonRequest(
        "/sign-in/email",
        {
          email: "maria@example.test",
          password: initialPassword,
        },
        undefined,
        SIGNIN_IP,
      ),
    );
    assert.equal(login.status, 200);
    const oldCookie = sessionCookie(login);

    const change = await auth.handler(
      jsonRequest(
        "/change-password",
        {
          currentPassword: initialPassword,
          newPassword: changedPassword,
          revokeOtherSessions: false,
        },
        oldCookie,
        SIGNIN_IP,
      ),
    );
    assert.equal(change.status, 200);

    const oldSession = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session?disableCookieCache=true", {
        headers: { cookie: oldCookie, "x-forwarded-for": SIGNIN_IP },
      }),
    );
    const oldSessionBody = await oldSession.json();
    assert.equal(oldSessionBody, null, "o token anterior à troca de senha deve ser inválido");

    const newLogin = await auth.handler(
      jsonRequest(
        "/sign-in/email",
        {
          email: "maria@example.test",
          password: changedPassword,
        },
        undefined,
        SIGNIN_IP,
      ),
    );
    assert.equal(newLogin.status, 200);
    const newCookie = sessionCookie(newLogin);
    assert.notEqual(newCookie, oldCookie);

    await admin.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'Usuário legado', 'legacy@example.test', true)`,
      [LEGACY_USER_ID],
    );
    await admin.query(
      `insert into accounts (id, account_id, provider_id, issuer, user_id, password)
       values ('legacy-credential-account', $1, 'credential', $3, $1, $2)`,
      [LEGACY_USER_ID, hashSync(legacyPassword, 4), CREDENTIAL_ISSUER],
    );
    const legacyLogin = await auth.handler(
      jsonRequest(
        "/sign-in/email",
        {
          email: "legacy@example.test",
          password: legacyPassword,
        },
        undefined,
        SIGNIN_IP,
      ),
    );
    assert.equal(legacyLogin.status, 200, "hash bcrypt importado deve autenticar");

    const sessions = await admin.query<{ count: string }>(
      "select count(*)::text as count from sessions where user_id = $1",
      [LEGACY_USER_ID],
    );
    assert.equal(sessions.rows[0]?.count, "1");

    // §32 — Session fixation: the attacker signs in first and plants S_A; the
    // victim's login receives S_A in the Cookie header and must mint a fresh
    // session S_B that never echoes the attacker's token. Better Auth always
    // creates a new session on login, but it does not revoke the pre-existing
    // one — pre-login token invalidation is only promised by the change-password
    // block above, which deletes every session of the user.
    await admin.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'Usuário atacante', 'attacker@example.test', true)`,
      [ATTACKER_USER_ID],
    );
    await admin.query(
      `insert into accounts (id, account_id, provider_id, issuer, user_id, password)
       values ('attacker-credential-account', $1, 'credential', $3, $1, $2)`,
      [ATTACKER_USER_ID, hashSync(attackerPassword, 4), CREDENTIAL_ISSUER],
    );
    const attackerLogin = await auth.handler(
      jsonRequest(
        "/sign-in/email",
        { email: "attacker@example.test", password: attackerPassword },
        undefined,
        ATTACKER_IP,
      ),
    );
    assert.equal(attackerLogin.status, 200);
    const attackerCookie = sessionCookie(attackerLogin);

    const victimLogin = await auth.handler(
      jsonRequest(
        "/sign-in/email",
        { email: "maria@example.test", password: changedPassword },
        attackerCookie,
        SIGNIN_IP,
      ),
    );
    assert.equal(victimLogin.status, 200);
    const victimSetCookie = victimLogin.headers.get("set-cookie");
    assert.ok(victimSetCookie, "login da vítima deve emitir Set-Cookie");
    const victimCookie = sessionCookie(victimLogin);
    assert.notEqual(victimCookie, attackerCookie, "S_B deve diferir de S_A");
    assert.ok(
      !decodeURIComponent(victimSetCookie).includes(cookieValue(attackerCookie)),
      "Set-Cookie da vítima não pode ecoar o token plantado pelo atacante",
    );
    assert.equal(
      await sessionEmail(auth, attackerCookie, ATTACKER_IP),
      "attacker@example.test",
      "S_A deve continuar pertencendo ao atacante",
    );
    assert.equal(
      await sessionEmail(auth, victimCookie, SIGNIN_IP),
      "maria@example.test",
      "S_B deve pertencer à vítima",
    );
  } finally {
    setEmailAdapterForTests(undefined);
    setDatabaseForTests(undefined);
    await pool.end();
    try {
      await cleanupFixtures(admin);
    } finally {
      await admin.end();
    }
  }

  console.log("Better Auth, tenant pessoal, cookie, bcrypt/scrypt, fixação de sessão: OK");
}

await main();
