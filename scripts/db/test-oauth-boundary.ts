import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "../../src/db/schema";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import { createAuthInstance } from "../../src/server/auth/auth.server";
import { requireAdminUrl } from "./migrate";

// AUTH-005 A+B: boundary OAuth do provider Google sem rede externa nem
// credenciais reais. As credenciais dummy vivem apenas neste processo; o
// state forjado é rejeitado no parse antes de qualquer troca de código e o
// fetch global fica instrumentado para provar que nenhum caso toca a rede.
const TEST_IP = "198.51.100.46";
const BASE_URL = "http://localhost:3000";
const OAUTH_CALLBACK_PATH = "/api/auth/callback/google";
const OAUTH_CALLBACK_URL = `${BASE_URL}${OAUTH_CALLBACK_PATH}`;
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_CLIENT_ID = "test-google-client-id";
const GOOGLE_CLIENT_SECRET = "test-google-client-secret";

interface VerificationRow {
  identifier: string;
  value: string;
  expires_at: Date;
}

function authRequest(path: string, init: RequestInit, ip = TEST_IP): Request {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", ip);
  return new Request(`${BASE_URL}/api/auth${path}`, { ...init, headers });
}

function socialRequest(options?: { headers?: Record<string, string>; cookie?: string }): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: BASE_URL,
    ...options?.headers,
  };
  if (options?.cookie) headers.cookie = options.cookie;
  return authRequest("/sign-in/social", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "google", disableRedirect: true }),
  });
}

async function main(): Promise<void> {
  const runtimePassword = randomBytes(24).toString("base64url");
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
  process.env.BETTER_AUTH_URL = BASE_URL;
  process.env.AUTH_TRUSTED_ORIGINS = BASE_URL;
  process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;

  const auth = createAuthInstance(database as unknown as Database);
  const createdStates: string[] = [];

  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outboundRequests += 1;
    throw new Error(`rede externa bloqueada no boundary OAuth: ${String(input)}`);
  }) as typeof fetch;

  try {
    const social = await auth.handler(socialRequest());
    assert.equal(social.status, 200);
    const socialBody = (await social.json()) as { url?: string; redirect?: boolean };
    assert.equal(socialBody.redirect, false);
    assert.ok(socialBody.url, "sign-in social deve retornar a URL de autorização");

    const authorizeUrl = new URL(socialBody.url);
    assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, GOOGLE_AUTHORIZE_URL);
    assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
    assert.equal(authorizeUrl.searchParams.get("client_id"), GOOGLE_CLIENT_ID);
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), OAUTH_CALLBACK_URL);
    assert.equal(authorizeUrl.searchParams.get("scope"), "email profile openid");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizeUrl.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    const state = authorizeUrl.searchParams.get("state");
    assert.ok(state, "authorization URL deve conter state");
    createdStates.push(state);

    const verification = await admin.query<VerificationRow>(
      `select identifier, value, expires_at from verifications where identifier = $1`,
      [state],
    );
    assert.equal(verification.rowCount, 1, "o state deve persistir em verifications");
    const expiresInMs = new Date(verification.rows[0]!.expires_at).getTime() - Date.now();
    assert.ok(
      expiresInMs > 9 * 60_000 && expiresInMs < 11 * 60_000,
      `state deve expirar em ~10 min (veio ${expiresInMs} ms)`,
    );
    const statePayload = JSON.parse(verification.rows[0]!.value) as {
      codeVerifier?: string;
      oauthState?: string;
      callbackURL?: string;
    };
    assert.equal(statePayload.oauthState, state);
    assert.equal(statePayload.callbackURL, BASE_URL);
    assert.match(statePayload.codeVerifier ?? "", /^[A-Za-z0-9_-]{128}$/);

    const forged = await auth.handler(
      authRequest(`${OAUTH_CALLBACK_PATH}?state=forged-state&code=forged-code`, {
        method: "GET",
      }),
    );
    assert.ok(forged.status >= 300, `callback com state forjado deve falhar (${forged.status})`);
    if (forged.status >= 300 && forged.status < 400) {
      assert.match(forged.headers.get("location") ?? "", /error=state_mismatch/);
    }
    assert.doesNotMatch(forged.headers.get("set-cookie") ?? "", /session_token=/);

    const evilOrigin = await auth.handler(
      socialRequest({
        headers: { origin: "https://evil.example" },
        cookie: "preco_que_da_lucro.session_token=forged",
      }),
    );
    assert.equal(evilOrigin.status, 403);
    const evilBody = (await evilOrigin.json()) as { code?: string; message?: string };
    assert.equal(evilBody.code, "INVALID_ORIGIN");
  } finally {
    globalThis.fetch = originalFetch;
    setDatabaseForTests(undefined);
    await pool.end();
    try {
      if (createdStates.length) {
        await admin.query(`delete from verifications where identifier = any($1::text[])`, [
          createdStates,
        ]);
      }
      await admin.query(`delete from rate_limits where key like $1`, [`${TEST_IP}|%`]);
    } finally {
      await admin.end();
    }
  }

  assert.equal(outboundRequests, 0, "nenhum caso pode chamar a rede externa");
  console.log("AUTH-005 A+B: boundary OAuth (state, PKCE, redirect, scopes, origem): OK");
}

await main();
