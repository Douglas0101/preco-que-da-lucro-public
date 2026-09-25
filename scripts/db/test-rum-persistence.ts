/**
 * §17.8 — valida a persistência de RUM (rum_vitals, migration 0014).
 *
 * Cobre dois níveis:
 *   1. unidade do handler `/api/vitals`: insert best-effort (sucesso grava;
 *      falha forçada do banco preserva o 204; flag desligada não toca o banco);
 *   2. integração com o banco descartável: a role app_runtime consegue INSERT
 *      (grant da 0014) e não consegue SELECT, e received_at usa o default.
 *
 * Uso: `npx tsx scripts/db/test-rum-persistence.ts` (DATABASE_ADMIN_URL local).
 */

import assert from "node:assert/strict";
import { Client } from "pg";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import { handleVitalsPost } from "../../src/routes/api/vitals";
import { requireAdminUrl } from "./migrate";

const samplePayload = {
  id: "v1-1712345678901-123456789",
  name: "LCP" as const,
  value: 1234.5,
  rating: "good" as const,
  delta: 12.3,
  navigationType: "navigate" as const,
};

function vitalsRequest(body: unknown): Request {
  return new Request("http://localhost/api/vitals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeInsert(handler: (row: unknown) => Promise<void>): {
  database: Database;
  insertCalls: () => number;
} {
  let calls = 0;
  const database = {
    insert: () => {
      calls += 1;
      return { values: handler };
    },
  } as unknown as Database;
  return { database, insertCalls: () => calls };
}

async function assertHandlerBestEffort(): Promise<void> {
  const written: unknown[] = [];
  const success = fakeInsert(async (row) => {
    written.push(row);
  });
  setDatabaseForTests(success.database);
  try {
    const response = await handleVitalsPost({ request: vitalsRequest(samplePayload) });
    assert.equal(response.status, 204, "payload válido deve responder 204");
    assert.equal(written.length, 1, "sucesso deve persistir exatamente uma linha");
    assert.deepEqual(written[0], {
      metricId: samplePayload.id,
      name: samplePayload.name,
      value: samplePayload.value,
      rating: samplePayload.rating,
      delta: samplePayload.delta,
      navigationType: samplePayload.navigationType,
    });
  } finally {
    setDatabaseForTests(undefined);
  }

  const failure = fakeInsert(async () => {
    throw new Error("forced db failure");
  });
  setDatabaseForTests(failure.database);
  try {
    const response = await handleVitalsPost({ request: vitalsRequest(samplePayload) });
    assert.equal(response.status, 204, "falha do banco não pode mudar o status 204");
    assert.equal(failure.insertCalls(), 1, "a tentativa de insert deve acontecer");
  } finally {
    setDatabaseForTests(undefined);
  }

  const previous = process.env.RUM_PERSISTENCE_ENABLED;
  process.env.RUM_PERSISTENCE_ENABLED = "false";
  const disabled = fakeInsert(async () => {});
  setDatabaseForTests(disabled.database);
  try {
    const response = await handleVitalsPost({ request: vitalsRequest(samplePayload) });
    assert.equal(response.status, 204);
    assert.equal(disabled.insertCalls(), 0, "flag desligada não pode tocar o banco");
  } finally {
    if (previous === undefined) delete process.env.RUM_PERSISTENCE_ENABLED;
    else process.env.RUM_PERSISTENCE_ENABLED = previous;
    setDatabaseForTests(undefined);
  }

  const invalid = fakeInsert(async () => {});
  setDatabaseForTests(invalid.database);
  try {
    const response = await handleVitalsPost({
      request: vitalsRequest({ ...samplePayload, value: -1 }),
    });
    assert.equal(response.status, 400, "payload inválido continua 400");
    assert.equal(invalid.insertCalls(), 0, "payload inválido não chega ao banco");
  } finally {
    setDatabaseForTests(undefined);
  }

  const oversized = fakeInsert(async () => {});
  setDatabaseForTests(oversized.database);
  try {
    const response = await handleVitalsPost({
      request: new Request("http://localhost/api/vitals", {
        method: "POST",
        headers: { "content-length": "4096" },
        body: "{}",
      }),
    });
    assert.equal(response.status, 413, "limite de 2 KB continua ativo");
    assert.equal(oversized.insertCalls(), 0);
  } finally {
    setDatabaseForTests(undefined);
  }
}

async function assertRuntimeInsertIntegration(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const metricId = `rum-test-${Date.now()}`;
  try {
    await client.query("begin");
    await client.query("set local role app_runtime");
    await client.query(
      `insert into rum_vitals (metric_id, name, value, rating, delta, navigation_type)
       values ($1, 'LCP', 1234.5, 'good', 12.3, 'navigate')`,
      [metricId],
    );
    await client.query("commit");

    const stored = await client.query<{
      metric_id: string;
      received_at: Date | null;
      value: number;
    }>(
      `select metric_id, value, received_at
       from rum_vitals
       where metric_id = $1`,
      [metricId],
    );
    assert.equal(stored.rowCount, 1, "app_runtime deve conseguir INSERT (grant 0014)");
    assert.equal(stored.rows[0]?.metric_id, metricId);
    assert.ok(stored.rows[0]?.received_at instanceof Date, "received_at deve usar o default now()");

    await client.query("begin");
    await client.query("set local role app_runtime");
    await assert.rejects(
      client.query("select count(*) from rum_vitals"),
      /permission denied/i,
      "app_runtime não pode ler a série (INSERT-only)",
    );
    await client.query("rollback");
  } finally {
    await client.query("delete from rum_vitals where metric_id = $1", [metricId]);
    await client.end();
  }
}

async function main(): Promise<void> {
  await assertHandlerBestEffort();
  await assertRuntimeInsertIntegration(requireAdminUrl());
  console.log("RUM persistence: insert best-effort + grant app_runtime INSERT (0014): OK");
}

await main();
