import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDatabaseForTests, type Database } from "@/db/client.server";
import { requireDatabaseAuth } from "@/middleware/request-context";

const harness = vi.hoisted(() => {
  const state = {
    headers: new Map<string, string>(),
    session: undefined as { user: { id: string } } | undefined,
  };
  return {
    state,
    requestHeaders: () => ({ get: (name: string) => state.headers.get(name) ?? null }),
    session: () => state.session,
  };
});

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({ headers: harness.requestHeaders() }),
}));

vi.mock("@/server/auth/auth.server", () => ({
  getAuth: () => ({ api: { getSession: async () => harness.session() } }),
}));

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";

const memberships = [
  {
    tenantId: TENANT_A,
    userId: USER_ID,
    role: "owner",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    tenantId: TENANT_B,
    userId: OTHER_USER_ID,
    role: "owner",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  },
];

interface RecordedQuery {
  kind: "execute" | "select";
  sql: string;
  params: unknown[];
}

function createFakeDatabase() {
  const dialect = new PgDialect();
  const timeline: RecordedQuery[] = [];
  let transactionCount = 0;
  const database = {
    transaction: async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
      transactionCount += 1;
      const transaction = {
        execute: async (fragment: SQL) => {
          const rendered = dialect.sqlToQuery(fragment);
          timeline.push({ kind: "execute", sql: rendered.sql, params: rendered.params });
          return { rows: [] };
        },
        select(fields?: Record<string, unknown>) {
          const builder = {
            table: undefined as unknown,
            whereFragment: undefined as unknown,
            from(table: unknown) {
              builder.table = table;
              return builder;
            },
            where(fragment: unknown) {
              builder.whereFragment = fragment;
              return builder;
            },
            orderBy() {
              return builder;
            },
            limit() {
              return builder;
            },
            then(
              onfulfilled?: ((value: unknown) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null,
            ) {
              const rendered = builder.whereFragment
                ? dialect.sqlToQuery(builder.whereFragment as SQL)
                : { sql: "", params: [] as unknown[] };
              timeline.push({ kind: "select", sql: rendered.sql, params: rendered.params });
              const hasTenantFilter = rendered.sql.includes("tenant_id");
              const requestedTenantId = rendered.params.find((param) =>
                memberships.some((membership) => membership.tenantId === param),
              );
              const currentUserId = harness.state.session?.user.id;
              const rows = hasTenantFilter
                ? memberships.filter(
                    (membership) =>
                      membership.tenantId === requestedTenantId &&
                      membership.userId === currentUserId,
                  )
                : memberships.filter((membership) => membership.userId === currentUserId);
              const projected = fields
                ? rows.map((row) =>
                    Object.fromEntries(
                      Object.keys(fields).map((key) => [key, (row as never)[key]]),
                    ),
                  )
                : rows;
              return Promise.resolve(projected).then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
      };
      return callback(transaction);
    },
  };
  return { database, timeline, transactionCount: () => transactionCount };
}

type MiddlewareInput = {
  context: { correlationId: string };
  next: (input: { context: { requestContext: unknown } }) => Promise<unknown>;
  signal: AbortSignal;
};

function invoke(next: MiddlewareInput["next"]): Promise<unknown> {
  return (requireDatabaseAuth as unknown as (input: MiddlewareInput) => Promise<unknown>)({
    context: { correlationId: CORRELATION_ID },
    next,
    signal: new AbortController().signal,
  });
}

afterEach(() => {
  setDatabaseForTests(undefined);
  harness.state.headers.clear();
  harness.state.session = undefined;
});

describe("T1 perf-waves: negação cross-tenant em requireDatabaseAuth", () => {
  it("usuário solicitando tenant existente de outro usuário recebe 403; GUC de tenant nunca é definido e a operação não executa", async () => {
    const fake = createFakeDatabase();
    setDatabaseForTests(fake.database as unknown as Database);
    harness.state.session = { user: { id: USER_ID } };
    harness.state.headers.set("x-tenant-id", TENANT_B);
    const next = vi.fn(async () => ({}));

    let caught: unknown;
    try {
      await invoke(next);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    const response = caught as Response;
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTHORIZATION_ERROR");
    expect(next).not.toHaveBeenCalled();
    const tenantGucStatements = fake.timeline.filter((query) =>
      query.sql.includes("app.current_tenant_id"),
    );
    expect(tenantGucStatements).toHaveLength(0);
  });

  it("caminho autorizado abre exatamente 1 transação com ordem user GUC → membership → tenant GUCs", async () => {
    const fake = createFakeDatabase();
    setDatabaseForTests(fake.database as unknown as Database);
    harness.state.session = { user: { id: USER_ID } };
    harness.state.headers.set("x-tenant-id", TENANT_A);
    const next = vi.fn(async ({ context }) => context.requestContext);

    const result = (await invoke(next)) as { userId: string; tenantId: string; roles: string[] };

    expect(fake.transactionCount()).toBe(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ userId: USER_ID, tenantId: TENANT_A, roles: ["owner"] });
    const userGucIndex = fake.timeline.findIndex(
      (query) => query.kind === "execute" && query.sql.includes("app.current_user_id"),
    );
    const tenantGucIndex = fake.timeline.findIndex(
      (query) => query.kind === "execute" && query.sql.includes("app.current_tenant_id"),
    );
    const membershipIndex = fake.timeline.findIndex((query) => query.kind === "select");
    expect(userGucIndex).toBeGreaterThanOrEqual(0);
    expect(userGucIndex).toBeLessThan(membershipIndex);
    expect(membershipIndex).toBeLessThan(tenantGucIndex);
    const tenantGuc = fake.timeline[tenantGucIndex];
    expect(tenantGuc.params).toContain(TENANT_A);
    expect(tenantGuc.params).toContain("owner");
  });

  it("sem header x-tenant-id usa a primeira membership (createdAt asc) e segue autorizado", async () => {
    const fake = createFakeDatabase();
    setDatabaseForTests(fake.database as unknown as Database);
    harness.state.session = { user: { id: USER_ID } };
    const next = vi.fn(async ({ context }) => context.requestContext);

    const result = (await invoke(next)) as { tenantId: string; roles: string[] };

    expect(fake.transactionCount()).toBe(1);
    expect(result).toMatchObject({ tenantId: TENANT_A, roles: ["owner"] });
  });

  it("header x-tenant-id inválido (não-uuid) é negado sem abrir transação", async () => {
    const fake = createFakeDatabase();
    setDatabaseForTests(fake.database as unknown as Database);
    harness.state.session = { user: { id: USER_ID } };
    harness.state.headers.set("x-tenant-id", "not-a-uuid");
    const next = vi.fn(async () => ({}));

    let caught: unknown;
    try {
      await invoke(next);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(fake.transactionCount()).toBe(0);
  });

  it("sessão ausente recebe 401 sem abrir transação", async () => {
    const fake = createFakeDatabase();
    setDatabaseForTests(fake.database as unknown as Database);
    harness.state.session = undefined;
    const next = vi.fn(async () => ({}));

    let caught: unknown;
    try {
      await invoke(next);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(fake.transactionCount()).toBe(0);
  });
});
