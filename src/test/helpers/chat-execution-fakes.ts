import { vi } from "vitest";
import { setDatabaseForTests, type Database } from "@/db/client.server";
import { applicationMetrics } from "@/instrumentation/telemetry";
import type { BudgetLedger } from "@/lib/ai/budget-ledger.server";
import {
  executeSendChatMessage,
  type ModelCaller,
  type ToolRunner,
} from "@/lib/chat-execution.server";
import type { Conversation } from "@/server/repositories/conversation.repository";
import type { ConversationService } from "@/server/services/conversation.service";
import type { RequestIdentity } from "@/lib/request-context";

/**
 * Fakes compartilhados pelos testes da instrumentação de chat (§29). O banco é
 * injetado por `setDatabaseForTests` — nenhum teste toca PostgreSQL.
 */
export function installFakeDatabase(options: { rateLimitAllowed?: boolean } = {}): void {
  // O bucket de rate limit lê `execute(...).rows`: a linha de contador aprovado
  // mantém o resto da suíte determinístico; `rateLimitAllowed: false` simula o
  // bucket saturado.
  const rateLimitRows =
    options.rateLimitAllowed === false ? [] : [{ count: 1, last_request: Date.now() }];
  setDatabaseForTests({
    transaction: async <T>(operation: (transaction: unknown) => Promise<T>): Promise<T> =>
      operation({ execute: async () => ({ rows: rateLimitRows }) }),
  } as unknown as Database);
}

export function restoreFakeDatabase(): void {
  setDatabaseForTests(undefined);
}

export function createFakeConversationService(): ConversationService {
  return {
    findForUser: async () => undefined,
    getOrCreate: async () =>
      ({
        id: "conv-1",
        currentProductId: null,
        conversationState: "idle",
      }) as unknown as Conversation,
    listMessages: async () => [],
    countRecentUserMessages: async () => 0,
    appendMessage: async () => ({ id: "msg-1" }),
    updateConversation: async () => undefined,
    deleteMessages: async () => undefined,
    findProduct: async () => null,
    validateProduct: async (_context, productId) => productId,
  };
}

export function createFakeBudgetLedger(): BudgetLedger {
  return {
    reserveChatInTransaction: async () => true,
    reserveAtomic: async () => ({
      status: "reserved" as const,
      usageId: "usage-1",
      budgetTokens: 64_000,
      reservedAt: new Date(),
    }),
    settle: async (usageId: string) => ({
      applied: true,
      usageId,
      budgetTokens: null,
      durationMs: null,
    }),
    sweepOrphans: async () => ({ expiredCount: 0, usageIds: [] }),
    // TRILHO B: dublê neutro — este caminho só é exercido contra PostgreSQL real
    // (`scripts/db/test-reconcile-ai-usage.ts`), não na execução de chat.
    reconcileUnknownUsage: async () => ({
      scannedCount: 0,
      failedCount: 0,
      usageIds: [],
      oldestAgeMs: null,
    }),
    releaseUnknownReservation: async (_tenantId: string, usageId: string) => ({
      applied: false,
      usageId,
      releasedTokens: null,
    }),
  };
}

export const instantToolRunner = (async () => ({
  ok: true as const,
  replayed: false,
  output: { result: { ok: true }, state: { currentProductId: null } },
})) as unknown as ToolRunner;

export const TEST_IDENTITY: RequestIdentity = {
  userId: "user-1",
  tenantId: "50000000-0000-4000-8000-000000000005",
  roles: ["owner"],
  correlationId: "60000000-0000-4000-8000-000000000006",
  signal: new AbortController().signal,
};

/** Roda o fluxo real de chat com banco/fakes injetados (sem PostgreSQL). */
export function runFakeChat(
  modelCaller: ModelCaller,
  options: { toolRunner?: ToolRunner; message?: string } = {},
) {
  return executeSendChatMessage({ message: options.message ?? "Olá" }, TEST_IDENTITY, {
    modelCaller,
    budgetLedger: createFakeBudgetLedger(),
    conversationService: createFakeConversationService(),
    toolRunner: options.toolRunner ?? instantToolRunner,
  });
}

export function toolCallResponse(name = "create_product"): Awaited<ReturnType<ModelCaller>> {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id: `call-${name}`, function: { name, arguments: "{}" } }],
        },
      },
    ],
  } as unknown as Awaited<ReturnType<ModelCaller>>;
}

export function contentResponse(content = "Pronto!"): Awaited<ReturnType<ModelCaller>> {
  return {
    choices: [{ message: { content } }],
  } as unknown as Awaited<ReturnType<ModelCaller>>;
}

export interface AiLatencyRecords {
  acknowledge: number[];
  firstContent: number[];
  final: number[];
}

/** Espiona os três histogramas do §29 e devolve os valores registrados. */
export function recordAiLatencyMetrics(): AiLatencyRecords {
  const records: AiLatencyRecords = { acknowledge: [], firstContent: [], final: [] };
  vi.spyOn(applicationMetrics.aiTimeToAcknowledge, "record").mockImplementation((value: number) => {
    records.acknowledge.push(value);
  });
  vi.spyOn(applicationMetrics.aiTimeToFirstContent, "record").mockImplementation(
    (value: number) => {
      records.firstContent.push(value);
    },
  );
  vi.spyOn(applicationMetrics.aiTimeToFinal, "record").mockImplementation((value: number) => {
    records.final.push(value);
  });
  return records;
}

/** Captura os logs JSON de `console.info` para inspecionar campos do evento. */
export function captureStructuredLogs(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "info").mockImplementation((record: unknown) => {
    events.push(JSON.parse(String(record)) as Record<string, unknown>);
  });
  return events;
}
