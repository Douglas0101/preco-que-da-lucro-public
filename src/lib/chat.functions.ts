import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { withTenantTransaction } from "@/db/client.server";
import { applicationMetrics, withSpan } from "@/instrumentation/telemetry";
import { recordSafely } from "@/instrumentation/safe-record";
import { assertGatewayEndpoint } from "@/lib/ai-endpoint.server";
import { ApplicationError } from "@/lib/api-error";
import { createTenantTransaction, numberSetting } from "@/lib/tenant-transaction";
import { executeSendChatMessage } from "@/lib/chat-execution.server";
import { gatewayToolsForState, type GatewayTool } from "@/lib/ai/tool-registry";
import { conversationService } from "@/server/services/conversation.service";
import { logJson } from "@/lib/structured-logger";
import { requireDatabaseIdentity } from "@/middleware/request-context";

const inTenantTransaction = createTenantTransaction(withTenantTransaction);

interface GatewayMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: GatewayToolCall[];
  tool_call_id?: string;
}

interface GatewayToolCall {
  id: string;
  function: { name: string; arguments: string };
}

const gatewayResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                function: z.object({
                  name: z.string().min(1),
                  arguments: z.string(),
                }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const sendInput = z.object({
  message: z.string().trim().min(1).max(4000),
  currentProductId: z.string().uuid().nullable().optional(),
});

function isTransientStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

const RETRY_BASE_DELAY_MS = 150;

/**
 * Full-jitter backoff (plan §14.7): uniform delay in [0, base * attempt), never
 * above the cap. Uses the CSPRNG from Web Crypto (available in Node and
 * browsers) instead of Math.random to keep the S2245 security hotspot out of
 * the new-code gate.
 */
function retryDelayMs(attempt: number): number {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  const unit = buffer[0]! / 2 ** 32;
  return Math.floor(unit * RETRY_BASE_DELAY_MS * attempt);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type GatewayResponse = z.output<typeof gatewayResponseSchema>;

type ModelCaller = (
  messages: GatewayMessage[],
  tools: GatewayTool[],
  requestSignal: AbortSignal,
) => Promise<GatewayResponse>;

async function fetchModelAttempt({
  apiKey,
  endpoint,
  model,
  messages,
  tools,
  signal,
  requestSignal,
  attempt,
  attempts,
}: Readonly<{
  apiKey: string;
  endpoint: URL;
  model: string;
  messages: GatewayMessage[];
  tools: GatewayTool[];
  signal: AbortSignal;
  requestSignal: AbortSignal;
  attempt: number;
  attempts: number;
}>): Promise<GatewayResponse | null> {
  const response = await withSpan(
    "ai.model.call",
    { "gen_ai.request.model": model, "app.ai.attempt": attempt },
    () =>
      fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
        signal,
      }),
  );
  if (response.status === 402) {
    applicationMetrics.aiQuotas.add(1);
    throw new ApplicationError("AI_QUOTA");
  }
  if (response.status === 429) throw new ApplicationError("RATE_LIMIT");
  if (!response.ok) {
    if (isTransientStatus(response.status) && attempt < attempts) {
      await delay(retryDelayMs(attempt), requestSignal);
      return null;
    }
    throw new ApplicationError("DEPENDENCY_ERROR");
  }
  const parsed = gatewayResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ApplicationError("DEPENDENCY_ERROR");
  return parsed.data;
}

async function runModelAttempt({
  apiKey,
  endpoint,
  model,
  messages,
  tools,
  requestSignal,
  attempt,
  attempts,
  timeoutMs,
}: Readonly<{
  apiKey: string;
  endpoint: URL;
  model: string;
  messages: GatewayMessage[];
  tools: GatewayTool[];
  requestSignal: AbortSignal;
  attempt: number;
  attempts: number;
  timeoutMs: number;
}>): Promise<GatewayResponse | null> {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)]);
  const attemptStartedAt = performance.now();
  let outcome = "error";
  try {
    const response = await fetchModelAttempt({
      apiKey,
      endpoint,
      model,
      messages,
      tools,
      signal,
      requestSignal,
      attempt,
      attempts,
    });
    outcome = response === null ? "retry" : "success";
    return response;
  } catch (error) {
    if (error instanceof ApplicationError) {
      outcome = error.code;
      throw error;
    }
    if (signal.aborted) {
      outcome = "AI_TIMEOUT";
      applicationMetrics.aiTimeouts.add(1);
      throw new ApplicationError("AI_TIMEOUT", { cause: error });
    }
    if (attempt >= attempts) {
      outcome = "DEPENDENCY_ERROR";
      throw new ApplicationError("DEPENDENCY_ERROR", { cause: error });
    }
    await delay(retryDelayMs(attempt), requestSignal);
    outcome = "retry";
    return null;
  } finally {
    const elapsedMs = performance.now() - attemptStartedAt;
    recordSafely(applicationMetrics.aiDuration, elapsedMs, {
      model,
      attempt,
    });
    logJson("info", "ai.model_attempt", {
      model,
      attempt,
      durationMs: Math.round(elapsedMs),
      outcome,
    });
  }
}

async function callModel(
  messages: GatewayMessage[],
  tools: GatewayTool[],
  requestSignal: AbortSignal,
): Promise<GatewayResponse> {
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new ApplicationError("DEPENDENCY_ERROR");
  const endpoint =
    process.env.AI_GATEWAY_URL ?? "https://ai.gateway.lovable.dev/v1/chat/completions";
  // Guard anti-SSRF na origem (G-SEC #10-13): o URL validado é o único que
  // alcança o fetch nos retries, cobrindo todas as instâncias com um check.
  const gatewayEndpoint = assertGatewayEndpoint(endpoint);
  const model = process.env.AI_MODEL ?? "google/gemini-3.6-flash";
  const attempts = numberSetting("AI_MODEL_MAX_ATTEMPTS", 2, 1, 2);
  const timeoutMs = numberSetting("AI_MODEL_TIMEOUT_MS", 30_000, 1_000, 30_000);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runModelAttempt({
      apiKey,
      endpoint: gatewayEndpoint,
      model,
      messages,
      tools,
      requestSignal,
      attempt,
      attempts,
      timeoutMs,
    });
    if (result) return { ...result, model: result.model ?? model };
  }
  throw new ApplicationError("DEPENDENCY_ERROR");
}

export const getChatHistory = createServerFn({ method: "GET" })
  .middleware([requireDatabaseIdentity])
  .handler(async ({ context }) =>
    inTenantTransaction(context.requestIdentity, async (request) => {
      const conversation = await conversationService.findForUser(request);
      if (!conversation) {
        return {
          messages: [],
          currentProductId: null,
          conversationState: "idle",
          confirmedState: {
            currentProductId: null,
            lastAssistantMessageId: null,
            lastConfirmedAt: null,
          },
        };
      }
      const messages = await conversationService.listMessages(request, conversation.id);
      return {
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          created_at: message.createdAt.toISOString(),
        })),
        currentProductId: conversation.currentProductId,
        conversationState: conversation.conversationState,
        confirmedState: {
          currentProductId:
            typeof conversation.confirmedState.currentProductId === "string"
              ? conversation.confirmedState.currentProductId
              : null,
          lastAssistantMessageId:
            typeof conversation.confirmedState.lastAssistantMessageId === "string"
              ? conversation.confirmedState.lastAssistantMessageId
              : null,
          lastConfirmedAt:
            typeof conversation.confirmedState.lastConfirmedAt === "string"
              ? conversation.confirmedState.lastConfirmedAt
              : null,
        },
      };
    }),
  );

export const createChatConversation = createServerFn({ method: "POST" })
  .middleware([requireDatabaseIdentity])
  .handler(async ({ context }) =>
    inTenantTransaction(context.requestIdentity, async (request) => {
      const conversation = await conversationService.getOrCreate(request);
      return {
        id: conversation.id,
        currentProductId: conversation.currentProductId,
      };
    }),
  );

export const clearChatHistory = createServerFn({ method: "POST" })
  .middleware([requireDatabaseIdentity])
  .handler(async ({ context }) =>
    inTenantTransaction(context.requestIdentity, async (request) => {
      const conversation = await conversationService.getOrCreate(request);
      await conversationService.deleteMessages(request, conversation.id);
      await conversationService.updateConversation(request, conversation.id, {
        currentProductId: null,
        confirmedState: {},
        conversationState: "idle",
        stateUpdatedAt: new Date(),
        resetAt: new Date(),
        updatedAt: new Date(),
      });
      return { ok: true as const };
    }),
  );

export const sendChatMessage = createServerFn({ method: "POST" })
  .middleware([requireDatabaseIdentity])
  .validator((input: unknown) => sendInput.parse(input))
  .handler(async ({ data, context }) =>
    executeSendChatMessage(data, context.requestIdentity, { modelCaller: callModel }),
  );

export { callModel as callModelForTests, retryDelayMs as retryDelayMsForTests };
