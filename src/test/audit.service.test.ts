import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditEvents, toolExecutions } from "@/db/schema";
import { runRegisteredTool } from "@/lib/ai/tool-runner";
import type { RequestContext } from "@/lib/request-context";
import {
  DrizzleAuditRepository,
  type AuditEventWrite,
  type AuditRepository,
} from "@/server/repositories/audit.repository";
import { DefaultAuditService, type AuditService } from "@/server/services/audit.service";
import { contextWithRole } from "./helpers/request-context";

interface CapturedInsert {
  table: unknown;
  values: Record<string, unknown>;
}

class FakeAuditTransaction {
  inserts: CapturedInsert[] = [];

  insert(table: unknown) {
    return {
      values: (values: Record<string, unknown>) => {
        this.inserts.push({ table, values });
        return Promise.resolve([]);
      },
    };
  }
}

class FakeAuditRepository implements AuditRepository {
  calls: Array<{ context: RequestContext; input: AuditEventWrite }> = [];

  async append(context: RequestContext, input: AuditEventWrite) {
    this.calls.push({ context, input });
  }
}

function contextWithFakeTransaction(transaction: FakeAuditTransaction): RequestContext {
  return {
    ...contextWithRole("owner"),
    transaction: transaction as unknown as RequestContext["transaction"],
  };
}

describe("DefaultAuditService", () => {
  it("delega ao repositório preservando contexto e payload", async () => {
    const repository = new FakeAuditRepository();
    const service: AuditService = new DefaultAuditService(repository);
    const context = contextWithRole("owner");
    const input: AuditEventWrite = {
      eventType: "ai.tool.succeeded",
      resourceType: "tool",
      resourceId: "create_product",
      safeMetadata: { durationMs: 7, replayed: false },
    };

    await service.append(context, input);

    expect(repository.calls).toHaveLength(1);
    expect(repository.calls[0]?.context).toBe(context);
    expect(repository.calls[0]?.input).toEqual(input);
  });

  it("não acessa o banco diretamente (SQL só no repositório)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/server/services/audit.service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']@\/db\//);
    expect(source).not.toMatch(/from\s+["']drizzle-orm/);
  });
});

describe("DrizzleAuditRepository", () => {
  it("grava o audit_event com tenant/user/correlation do contexto", async () => {
    const transaction = new FakeAuditTransaction();
    const context = contextWithFakeTransaction(transaction);
    const input: AuditEventWrite = {
      eventType: "ai.tool.rejected",
      resourceType: "tool",
      resourceId: "set_yield",
      safeMetadata: { code: "AUTHORIZATION_ERROR", inputHash: "hash", durationMs: 3 },
    };

    await new DrizzleAuditRepository().append(context, input);

    expect(transaction.inserts).toHaveLength(1);
    expect(transaction.inserts[0]?.table).toBe(auditEvents);
    expect(transaction.inserts[0]?.values).toEqual({
      tenantId: context.tenantId,
      userId: context.userId,
      correlationId: context.correlationId,
      eventType: "ai.tool.rejected",
      resourceType: "tool",
      resourceId: "set_yield",
      safeMetadata: { code: "AUTHORIZATION_ERROR", inputHash: "hash", durationMs: 3 },
    });
  });

  it("normaliza campos opcionais ausentes para null (formato atual do insert)", async () => {
    const transaction = new FakeAuditTransaction();
    const context = contextWithFakeTransaction(transaction);

    await new DrizzleAuditRepository().append(context, { eventType: "ai.tool.cancelled" });

    expect(transaction.inserts[0]?.values).toEqual({
      tenantId: context.tenantId,
      userId: context.userId,
      correlationId: context.correlationId,
      eventType: "ai.tool.cancelled",
      resourceType: null,
      resourceId: null,
      safeMetadata: null,
    });
  });
});

describe("tool-runner -> AuditService (wiring §9.1)", () => {
  it("audita a rejeição via repositório na transação do contexto", async () => {
    const transaction = new FakeAuditTransaction();
    const context = contextWithFakeTransaction(transaction);

    const result = await runRegisteredTool({
      context,
      name: "set_yield",
      rawArguments: "{não-é-json",
      idempotencyKey: "conversation:call-wiring",
    });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR", replayed: false });
    expect(transaction.inserts).toHaveLength(2);
    expect(transaction.inserts[0]?.table).toBe(toolExecutions);
    expect(transaction.inserts[1]?.table).toBe(auditEvents);
    expect(transaction.inserts[1]?.values).toMatchObject({
      tenantId: context.tenantId,
      userId: context.userId,
      correlationId: context.correlationId,
      eventType: "ai.tool.rejected",
      resourceType: "tool",
      resourceId: "set_yield",
      safeMetadata: { code: "VALIDATION_ERROR" },
    });
  });
});
