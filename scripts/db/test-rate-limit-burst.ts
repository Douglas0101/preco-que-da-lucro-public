import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import type { Database } from "../../src/db/client.server";
import {
  USER_RATE_LIMIT_RULES,
  userRateLimitKey,
} from "../../src/server/auth/rate-limit-rules.server";
import { consumeRateLimitInTransaction } from "../../src/server/auth/rate-limit-storage.server";
import { requireAdminUrl } from "./migrate";

/**
 * §20.5: prova de atomicidade do bucket de chat/tool sob concorrência
 * distribuída. Duas instâncias (dois pools) disputam a mesma chave; o total de
 * admissões tem de ser exatamente o `max` da regra, nunca mais.
 *
 * Uso: DATABASE_URL/ADMIN_URL apontando ao container local + `flock` do banco.
 * `tsx scripts/db/test-rate-limit-burst.ts --report <caminho.json>` grava o
 * relatório cru; sem `--report` o JSON vai para stdout.
 */

const CHAT_USER = "79000000-0000-4000-8000-00000000000a";
const TOOL_USER = "79000000-0000-4000-8000-00000000000b";
const TEST_KEYS = [
  userRateLimitKey("chat", CHAT_USER),
  userRateLimitKey("tool", TOOL_USER),
] as const;
// Conexões por instância: precisa cobrir a rajada inteira para que as
// requisições realmente se sobreponham (o lock da linha serializa o UPDATE).
const POOL_MAX = 24;

interface BurstResult {
  bucket: string;
  key: string;
  rule: { window: number; max: number };
  concurrency: number;
  instances: number;
  allowed: number;
  denied: number;
  retryAfterSeconds: number[];
  persistedCount: number;
  counterRows: number;
}

function pool(): Pool {
  return new Pool({ connectionString: requireAdminUrl(), max: POOL_MAX });
}

function client(poolInstance: Pool): Database {
  // SAFETY: this script runs node-postgres against the local container, and the
  // cast mirrors the same cross-driver structural assertion as
  // src/db/client.server.ts - both driver branches must expose the operations the
  // local `Database` interface requires, which TypeScript cannot unify.
  return drizzle({ client: poolInstance, schema }) as unknown as Database;
}

async function burst(
  clients: Database[],
  bucket: "chat" | "tool",
  userId: string,
  concurrency: number,
): Promise<Omit<BurstResult, "persistedCount" | "counterRows">> {
  const rule = USER_RATE_LIMIT_RULES[bucket];
  const key = userRateLimitKey(bucket, userId);
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      clients[index % clients.length]!.transaction((transaction) =>
        consumeRateLimitInTransaction(transaction, key, rule),
      ),
    ),
  );
  const denied = results.filter((result) => !result.allowed);
  return {
    bucket,
    key,
    rule,
    concurrency,
    instances: clients.length,
    allowed: results.length - denied.length,
    denied: denied.length,
    retryAfterSeconds: denied.map((result) => result.retryAfter ?? 0),
  };
}

async function bucketRows(poolInstance: Pool, key: string): Promise<{ count: number }[]> {
  const result = await poolInstance.query<{ count: string }>(
    "select count::text as count from rate_limits where key = $1",
    [key],
  );
  return result.rows.map((row) => ({ count: Number(row.count) }));
}

/** Chaves deste script apenas: mantém a execução repetível sem tocar em outros buckets. */
async function cleanupBuckets(poolInstance: Pool): Promise<void> {
  await poolInstance.query("delete from rate_limits where key = any($1::text[])", [TEST_KEYS]);
}

async function main(): Promise<void> {
  const pools = [pool(), pool()];
  const clients = pools.map(client);
  const reportPathIndex = process.argv.indexOf("--report");
  const reportPath = reportPathIndex === -1 ? null : process.argv[reportPathIndex + 1];
  const report: BurstResult[] = [];

  try {
    await cleanupBuckets(pools[0]!);

    for (const [bucket, userId] of [
      ["chat", CHAT_USER],
      ["tool", TOOL_USER],
    ] as const) {
      const { max } = USER_RATE_LIMIT_RULES[bucket];
      const concurrency = max + Math.ceil(max / 4);
      const result = await burst(clients, bucket, userId, concurrency);
      const rows = await bucketRows(pools[0]!, result.key);
      const persistedCount = rows[0]?.count ?? 0;
      assert.equal(
        result.allowed,
        max,
        `${bucket}: o bucket atômico deve admitir exatamente ${max} de ${concurrency} concorrentes`,
      );
      assert.equal(result.denied, concurrency - max, `${bucket}: o resto deve ser recusado`);
      assert.equal(persistedCount, max, `${bucket}: o contador persistido deve ser exatamente max`);
      assert.equal(rows.length, 1, `${bucket}: a chave deve ocupar uma única linha`);
      // `now` é capturado antes do lock da linha: um concorrente que esperou
      // pode devolver retryAfter marginalmente acima da janela.
      assert.ok(
        result.retryAfterSeconds.every(
          (seconds) => seconds >= 1 && seconds <= result.rule.window + 60,
        ),
        `${bucket}: retryAfter deve ficar na ordem da janela da regra`,
      );
      report.push({ ...result, persistedCount, counterRows: rows.length });
      console.log(
        `${bucket}: ${result.allowed} admitidas / ${result.denied} recusadas ` +
          `(max=${max}, janela=${result.rule.window}s, concorrência=${concurrency}, ` +
          `instâncias=${result.instances}), contador=${persistedCount}, ` +
          `retryAfter=${Math.min(...result.retryAfterSeconds)}–${Math.max(
            ...result.retryAfterSeconds,
          )}s`,
      );
    }

    const serialized = `${JSON.stringify(
      {
        script: "scripts/db/test-rate-limit-burst.ts",
        buckets: report,
      },
      null,
      2,
    )}\n`;
    if (reportPath) {
      writeFileSync(reportPath, serialized);
      console.log(`T20.5: relatório cru gravado em ${reportPath}`);
    } else {
      process.stdout.write(serialized);
    }
    console.log("T20.5: buckets de chat/tool são atômicos sob concorrência distribuída: OK");
  } finally {
    await cleanupBuckets(pools[0]!);
    await Promise.all(pools.map((instance) => instance.end()));
  }
}

await main();
