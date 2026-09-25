import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { idempotencyRecords, toolExecutions } from "@/db/schema";
import type { ApiErrorCode } from "@/lib/api-error";
import { errorCodeFromUnknown } from "@/lib/api-error";
import type { RequestContext } from "@/lib/request-context";
import { logJson } from "@/lib/structured-logger";
import { applicationMetrics, withSpan } from "@/instrumentation/telemetry";
import { recordSafely } from "@/instrumentation/safe-record";
import { auditService } from "@/server/services/audit.service";
import { USER_RATE_LIMIT_RULES, userRateLimitKey } from "@/server/auth/rate-limit-rules.server";
import { consumeRateLimitInTransaction } from "@/server/auth/rate-limit-storage.server";
import {
  TOOL_REGISTRY,
  toolExecutionOutputSchema,
  type PreparedTool,
  type ToolExecutionOutput,
} from "./tool-registry";
import { sanitizeToolInput } from "./tool-payload";

export type ToolRunResult =
  | { ok: true; output: ToolExecutionOutput; replayed: boolean }
  | { ok: false; code: ApiErrorCode; replayed: boolean };

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function inputHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** Recursive JSON shape this normaliser can emit. Naming it keeps the contract
 * explicit instead of `unknown`; the `toolExecutionOutputSchema` parse at the call
 * site stays the single source of truth for the domain type. */
type SanitizedJson =
  string | number | boolean | null | SanitizedJson[] | { [key: string]: SanitizedJson };

function sanitizeJson(value: unknown, depth = 0): SanitizedJson {
  if (depth > 8) return null;
  if (typeof value === "string") {
    return Array.from(value)
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return !(
          code <= 8 ||
          code === 11 ||
          code === 12 ||
          (code >= 14 && code <= 31) ||
          code === 127
        );
      })
      .join("")
      .slice(0, 8_000);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeJson(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [key.slice(0, 120), sanitizeJson(entry, depth + 1)]),
    );
  }
  return null;
}

function sanitizeToolOutput(value: unknown): ToolExecutionOutput | null {
  const parsed = toolExecutionOutputSchema.safeParse(sanitizeJson(value));
  return parsed.success ? parsed.data : null;
}

function publicFailure(code: ApiErrorCode): ToolRunResult {
  return { ok: false, code, replayed: false };
}

interface ToolExecutionTrace {
  input: Record<string, unknown> | null;
  toolCallId?: string;
  usageId?: string;
}

async function persistRejected(
  context: RequestContext,
  toolName: string,
  hash: string,
  code: ApiErrorCode,
  startedAt: number,
  trace: ToolExecutionTrace,
): Promise<void> {
  const tx = context.transaction as DatabaseTransaction;
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  await tx.insert(toolExecutions).values({
    tenantId: context.tenantId,
    userId: context.userId,
    correlationId: context.correlationId,
    toolName,
    inputHash: hash,
    input: trace.input,
    toolCallId: trace.toolCallId ?? null,
    usageId: trace.usageId ?? null,
    status: "failed",
    durationMs,
    errorCode: code,
    completedAt: new Date(),
  });
  await auditService.append(context, {
    eventType: "ai.tool.rejected",
    resourceType: "tool",
    resourceId: toolName,
    safeMetadata: { code, inputHash: hash, durationMs },
  });
  applicationMetrics.toolExecutions.add(1, { tool: toolName, status: "rejected", code });
  recordSafely(applicationMetrics.toolDuration, durationMs, { tool: toolName, status: "rejected" });
}

type PreparedToolSuccess = Extract<PreparedTool, { ok: true }>;

async function prepareToolRequest(
  context: RequestContext,
  name: string,
  rawArguments: string,
  startedAt: number,
  trace: Pick<ToolExecutionTrace, "toolCallId" | "usageId">,
): Promise<
  | { hash: string; input: Record<string, unknown> | null; prepared: PreparedToolSuccess }
  | { failure: ToolRunResult }
> {
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(rawArguments || "{}");
  } catch {
    const hash = inputHash(rawArguments);
    await persistRejected(context, name, hash, "VALIDATION_ERROR", startedAt, {
      input: null,
      ...trace,
    });
    return { failure: publicFailure("VALIDATION_ERROR") };
  }

  const hash = inputHash(rawInput);
  const input = sanitizeToolInput(rawInput);
  const definition = TOOL_REGISTRY.get(name);
  if (!definition) {
    await persistRejected(context, name, hash, "VALIDATION_ERROR", startedAt, { input, ...trace });
    return { failure: publicFailure("VALIDATION_ERROR") };
  }
  const prepared = definition.prepare(context, rawInput);
  if (!prepared.ok) {
    await persistRejected(context, name, hash, prepared.code, startedAt, { input, ...trace });
    return { failure: publicFailure(prepared.code) };
  }
  return { hash, input, prepared };
}

async function resolveExistingClaim(
  context: RequestContext,
  name: string,
  idempotencyKey: string,
  hash: string,
): Promise<ToolRunResult | { claimId: string } | null> {
  const tx = context.transaction as DatabaseTransaction;
  const [existing] = await tx
    .select()
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
  if (!existing) return null;
  if (existing.expiresAt <= new Date()) {
    await tx
      .update(idempotencyRecords)
      .set({
        requestHash: hash,
        status: "pending",
        response: null,
        errorCode: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        updatedAt: new Date(),
      })
      .where(eq(idempotencyRecords.id, existing.id));
    return { claimId: existing.id };
  }
  if (existing.requestHash !== hash) return publicFailure("CONFLICT");
  if (existing.status === "succeeded" && existing.response) {
    const replayedOutput = sanitizeToolOutput(existing.response);
    if (!replayedOutput) return publicFailure("DATABASE_ERROR");
    return { ok: true, output: replayedOutput, replayed: true };
  }
  return {
    ok: false,
    code: (existing?.errorCode as ApiErrorCode | null) ?? "CONFLICT",
    replayed: true,
  };
}

export async function runRegisteredTool(options: {
  context: RequestContext;
  name: string;
  rawArguments: string;
  idempotencyKey: string;
  toolCallId?: string;
  usageId?: string;
  allowedToolNames?: readonly string[];
  requireConfirmation?: boolean;
  confirmed?: boolean;
}): Promise<ToolRunResult> {
  const {
    context,
    name,
    rawArguments,
    idempotencyKey,
    toolCallId,
    usageId,
    allowedToolNames,
    requireConfirmation = false,
    confirmed = false,
  } = options;
  const tx = context.transaction as DatabaseTransaction;
  const startedAt = performance.now();
  const trace = { toolCallId, usageId };
  const preparedRequest = await prepareToolRequest(context, name, rawArguments, startedAt, trace);
  if ("failure" in preparedRequest) return preparedRequest.failure;
  const { hash, input, prepared } = preparedRequest;

  if (allowedToolNames && !allowedToolNames.includes(name)) {
    await persistRejected(context, name, hash, "AUTHORIZATION_ERROR", startedAt, {
      input,
      ...trace,
    });
    return publicFailure("AUTHORIZATION_ERROR");
  }
  if (requireConfirmation && !confirmed) {
    await persistRejected(context, name, hash, "AUTHORIZATION_ERROR", startedAt, {
      input,
      ...trace,
    });
    return publicFailure("AUTHORIZATION_ERROR");
  }

  // Admission (§20.5) after Zod+AuthZ and before the idempotency claim: a
  // denied call must not occupy the (tenant, user, operation, key) row, or the
  // retry would replay it as if it had been accepted.
  const admission = await consumeRateLimitInTransaction(
    tx,
    userRateLimitKey("tool", context.userId),
    USER_RATE_LIMIT_RULES.tool,
  );
  if (!admission.allowed) {
    await persistRejected(context, name, hash, "RATE_LIMIT", startedAt, { input, ...trace });
    return publicFailure("RATE_LIMIT");
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  let claimed = await tx
    .insert(idempotencyRecords)
    .values({
      tenantId: context.tenantId,
      userId: context.userId,
      operation: `ai.tool.${name}`,
      key: idempotencyKey,
      requestHash: hash,
      status: "pending",
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyRecords.id });

  if (!claimed[0]) {
    const existing = await resolveExistingClaim(context, name, idempotencyKey, hash);
    if (existing && "claimId" in existing) {
      claimed = [{ id: existing.claimId }];
    } else if (existing) {
      return existing;
    }
  }

  if (!claimed[0]) {
    claimed = await tx
      .insert(idempotencyRecords)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        operation: `ai.tool.${name}`,
        key: idempotencyKey,
        requestHash: hash,
        status: "pending",
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyRecords.id });
    if (!claimed[0]) {
      const raced = await resolveExistingClaim(context, name, idempotencyKey, hash);
      if (raced && "claimId" in raced) claimed = [{ id: raced.claimId }];
      else return raced ?? publicFailure("CONFLICT");
    }
  }

  const [execution] = await tx
    .insert(toolExecutions)
    .values({
      tenantId: context.tenantId,
      userId: context.userId,
      correlationId: context.correlationId,
      toolName: name,
      inputHash: hash,
      input: sanitizeToolInput(prepared.input),
      toolCallId: toolCallId ?? null,
      usageId: usageId ?? null,
      status: "pending",
      idempotencyKey,
    })
    .returning({ id: toolExecutions.id });
  if (!execution) return publicFailure("DATABASE_ERROR");

  try {
    context.signal.throwIfAborted();
    const rawOutput = await withSpan(
      "ai.tool.execute",
      {
        "app.correlation_id": context.correlationId,
        "app.tenant_id": context.tenantId,
        "ai.tool.name": name,
      },
      () => prepared.execute(),
    );
    const output = sanitizeToolOutput(rawOutput);
    if (!output) throw new Error("DEPENDENCY_ERROR");
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    await tx
      .update(toolExecutions)
      .set({ status: "succeeded", durationMs, safeResult: output, completedAt: new Date() })
      .where(eq(toolExecutions.id, execution.id));
    await tx
      .update(idempotencyRecords)
      .set({ status: "succeeded", response: output, updatedAt: new Date() })
      .where(eq(idempotencyRecords.id, claimed[0].id));
    await auditService.append(context, {
      eventType: "ai.tool.succeeded",
      resourceType: "tool",
      resourceId: name,
      safeMetadata: { durationMs, replayed: false },
    });
    applicationMetrics.toolExecutions.add(1, { tool: name, status: "succeeded" });
    recordSafely(applicationMetrics.toolDuration, durationMs, { tool: name, status: "succeeded" });
    return { ok: true, output, replayed: false };
  } catch (error) {
    const mapped = errorCodeFromUnknown(error);
    const code = context.signal.aborted
      ? "AI_TIMEOUT"
      : mapped === "INTERNAL_ERROR"
        ? "DATABASE_ERROR"
        : mapped;
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    await tx
      .update(toolExecutions)
      .set({
        status: code === "AI_TIMEOUT" ? "cancelled" : "failed",
        durationMs,
        errorCode: code,
        completedAt: new Date(),
      })
      .where(eq(toolExecutions.id, execution.id));
    await tx
      .update(idempotencyRecords)
      .set({ status: "failed", errorCode: code, updatedAt: new Date() })
      .where(eq(idempotencyRecords.id, claimed[0].id));
    await auditService.append(context, {
      eventType: code === "AI_TIMEOUT" ? "ai.tool.cancelled" : "ai.tool.failed",
      resourceType: "tool",
      resourceId: name,
      safeMetadata: { code, durationMs },
    });
    const status = code === "AI_TIMEOUT" ? "cancelled" : "failed";
    applicationMetrics.toolExecutions.add(1, { tool: name, status, code });
    recordSafely(applicationMetrics.toolDuration, durationMs, { tool: name, status });
    logJson("warn", "ai.tool_failed", {
      correlationId: context.correlationId,
      toolName: name,
      code,
      error,
    });
    return { ok: false, code, replayed: false };
  }
}
