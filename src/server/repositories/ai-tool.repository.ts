import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { idempotencyRecords, toolExecutions } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

export interface ExistingToolClaim {
  requestHash: string;
  status: string;
  response: Record<string, unknown> | null;
  errorCode: string | null;
}

export interface RejectedToolWrite {
  toolName: string;
  inputHash: string;
  errorCode: string;
  durationMs: number;
  toolCallId?: string | null;
  input?: Record<string, unknown> | null;
  usageId?: string | null;
}

export interface ToolExecutionStart {
  name: string;
  requestHash: string;
  idempotencyKey: string;
  toolCallId?: string | null;
  input?: Record<string, unknown> | null;
  usageId?: string | null;
}

/** Contrato de persistência de execuções de tool (§9.2). O singleton tipado é o
 * ponto de injeção para consumidores; o SQL permanece no repositório. */
export interface AiToolRepository {
  persistRejected(context: RequestContext, payload: RejectedToolWrite): Promise<void>;
  findClaim(
    context: RequestContext,
    name: string,
    idempotencyKey: string,
  ): Promise<ExistingToolClaim | undefined>;
  claim(
    context: RequestContext,
    input: { name: string; idempotencyKey: string; requestHash: string; expiresAt: Date },
  ): Promise<string | undefined>;
  startExecution(context: RequestContext, input: ToolExecutionStart): Promise<string | undefined>;
  markSucceeded(
    context: RequestContext,
    executionId: string,
    claimId: string,
    output: Record<string, unknown>,
    durationMs: number,
  ): Promise<void>;
  markFailed(
    context: RequestContext,
    executionId: string,
    claimId: string,
    errorCode: string,
    durationMs: number,
  ): Promise<void>;
}

export class DrizzleAiToolRepository implements AiToolRepository {
  async persistRejected(context: RequestContext, payload: RejectedToolWrite): Promise<void> {
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    await tx.insert(toolExecutions).values({
      tenantId: context.tenantId,
      userId: context.userId,
      correlationId: context.correlationId,
      toolName: payload.toolName,
      inputHash: payload.inputHash,
      input: payload.input ?? null,
      toolCallId: payload.toolCallId ?? null,
      usageId: payload.usageId ?? null,
      status: "failed",
      durationMs: payload.durationMs,
      errorCode: payload.errorCode,
      completedAt: new Date(),
    });
  }

  async findClaim(
    context: RequestContext,
    name: string,
    idempotencyKey: string,
  ): Promise<ExistingToolClaim | undefined> {
    const tx = context.transaction as DatabaseTransaction;
    const [existing] = await tx
      .select({
        requestHash: idempotencyRecords.requestHash,
        status: idempotencyRecords.status,
        response: idempotencyRecords.response,
        errorCode: idempotencyRecords.errorCode,
      })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.tenantId, context.tenantId),
          eq(idempotencyRecords.userId, context.userId),
          eq(idempotencyRecords.operation, `ai.tool.${name}`),
          eq(idempotencyRecords.key, idempotencyKey),
        ),
      )
      .limit(1);
    return existing;
  }

  async claim(
    context: RequestContext,
    input: { name: string; idempotencyKey: string; requestHash: string; expiresAt: Date },
  ): Promise<string | undefined> {
    const tx = context.transaction as DatabaseTransaction;
    const [claimed] = await tx
      .insert(idempotencyRecords)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        operation: `ai.tool.${input.name}`,
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        status: "pending",
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyRecords.id });
    return claimed?.id;
  }

  async startExecution(
    context: RequestContext,
    input: ToolExecutionStart,
  ): Promise<string | undefined> {
    const tx = context.transaction as DatabaseTransaction;
    const [execution] = await tx
      .insert(toolExecutions)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        correlationId: context.correlationId,
        toolName: input.name,
        inputHash: input.requestHash,
        input: input.input ?? null,
        toolCallId: input.toolCallId ?? null,
        usageId: input.usageId ?? null,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: toolExecutions.id });
    return execution?.id;
  }

  async markSucceeded(
    context: RequestContext,
    executionId: string,
    claimId: string,
    output: Record<string, unknown>,
    durationMs: number,
  ): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    await tx
      .update(toolExecutions)
      .set({ status: "succeeded", durationMs, safeResult: output, completedAt: new Date() })
      .where(
        and(
          eq(toolExecutions.id, executionId),
          eq(toolExecutions.tenantId, context.tenantId),
          eq(toolExecutions.userId, context.userId),
        ),
      );
    await tx
      .update(idempotencyRecords)
      .set({ status: "succeeded", response: output, updatedAt: new Date() })
      .where(
        and(
          eq(idempotencyRecords.id, claimId),
          eq(idempotencyRecords.tenantId, context.tenantId),
          eq(idempotencyRecords.userId, context.userId),
        ),
      );
  }

  async markFailed(
    context: RequestContext,
    executionId: string,
    claimId: string,
    errorCode: string,
    durationMs: number,
  ): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    await tx
      .update(toolExecutions)
      .set({ status: "failed", durationMs, errorCode, completedAt: new Date() })
      .where(
        and(
          eq(toolExecutions.id, executionId),
          eq(toolExecutions.tenantId, context.tenantId),
          eq(toolExecutions.userId, context.userId),
        ),
      );
    await tx
      .update(idempotencyRecords)
      .set({ status: "failed", errorCode, updatedAt: new Date() })
      .where(
        and(
          eq(idempotencyRecords.id, claimId),
          eq(idempotencyRecords.tenantId, context.tenantId),
          eq(idempotencyRecords.userId, context.userId),
        ),
      );
  }
}

export const aiToolRepository: AiToolRepository = new DrizzleAiToolRepository();
