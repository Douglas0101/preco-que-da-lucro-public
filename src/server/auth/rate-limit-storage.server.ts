import { sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "@/db/client.server";
import { rateLimits } from "@/db/schema";

type RateLimitValue = {
  key: string;
  count: number;
  lastRequest: number;
};

export type RateLimitRule = { window: number; max: number };

export interface RateLimitConsumeResult {
  allowed: boolean;
  retryAfter: number | null;
}

/**
 * Transactional check-and-increment of a single bucket. The INSERT ... ON
 * CONFLICT DO NOTHING materializes the row before the UPDATE so concurrent
 * first requests serialize on the unique key instead of racing on INSERT, and
 * the UPDATE row lock makes the bucket exact across instances.
 *
 * Auth buckets call it in a standalone transaction (Better Auth storage);
 * chat/tool admission calls it inside the request transaction, before any
 * other side effect of the turn.
 */
export async function consumeRateLimitInTransaction(
  transaction: DatabaseTransaction,
  key: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): Promise<RateLimitConsumeResult> {
  const windowMs = rule.window * 1000;
  const cutoff = now - windowMs;

  await transaction.execute(sql`
    insert into ${rateLimits} (key, count, last_request)
    values (${key}, 0, ${now})
    on conflict (key) do nothing
  `);

  const updated = await transaction.execute<{
    count: number | string;
    last_request: number | string;
  }>(sql`
    update ${rateLimits}
    set count = case
          when last_request < ${cutoff} then 1
          else count + 1
        end,
        last_request = ${now}
    where key = ${key}
      and (last_request < ${cutoff} or count < ${rule.max})
    returning count, last_request
  `);

  if (updated.rows[0]) {
    return { allowed: true, retryAfter: null };
  }

  const current = await transaction.execute<{
    last_request: number | string;
  }>(sql`
    select last_request
    from ${rateLimits}
    where key = ${key}
    limit 1
  `);
  const lastRequest = Number(current.rows[0]?.last_request ?? now);
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((lastRequest + windowMs - now) / 1000)),
  };
}

/**
 * Better Auth's default Drizzle adapter exposes get/set for rate limits. That
 * fallback is not safe under concurrent inserts: two instances can both miss
 * the row and race on the unique key. Keep the storage in PostgreSQL, but make
 * consume a transactionally locked check-and-increment operation.
 */
export function createDatabaseRateLimitStorage(database: Database) {
  return {
    async get(key: string): Promise<RateLimitValue | null> {
      const result = await database.execute<{
        key: string;
        count: number | string;
        last_request: number | string;
      }>(sql`
        select key, count, last_request
        from ${rateLimits}
        where key = ${key}
        limit 1
      `);
      const row = result.rows[0];
      return row
        ? {
            key: row.key,
            count: Number(row.count),
            lastRequest: Number(row.last_request),
          }
        : null;
    },

    async set(key: string, value: RateLimitValue): Promise<void> {
      await database.execute(sql`
        insert into ${rateLimits} (key, count, last_request)
        values (${key}, ${value.count}, ${value.lastRequest})
        on conflict (key) do update
          set count = excluded.count,
              last_request = excluded.last_request
      `);
    },

    async consume(key: string, rule: RateLimitRule): Promise<RateLimitConsumeResult> {
      // The timestamp is taken when the request is admitted, not when the row
      // lock is acquired; the window boundary does not depend on lock waits.
      const now = Date.now();
      return database.transaction((transaction) =>
        consumeRateLimitInTransaction(transaction, key, rule, now),
      );
    },
  };
}
