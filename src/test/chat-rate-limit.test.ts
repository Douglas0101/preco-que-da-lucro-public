import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetLedger } from "@/lib/ai/budget-ledger.server";
import {
  executeSendChatMessage,
  chatRateLimitRule,
  type ModelCaller,
} from "@/lib/chat-execution.server";
import type { ConversationService } from "@/server/services/conversation.service";
import {
  TEST_IDENTITY,
  contentResponse,
  createFakeBudgetLedger,
  createFakeConversationService,
  installFakeDatabase,
  restoreFakeDatabase,
} from "./helpers/chat-execution-fakes";

const CHAT_LIMIT_ENV = "AI_CHAT_LIMIT_PER_10_MINUTES";

afterEach(() => {
  restoreFakeDatabase();
  vi.unstubAllEnvs();
});

/** Registra a ordem dos efeitos colaterais do turno: nenhum pode preceder a admissão. */
function trackingConversationService(calls: string[]): ConversationService {
  return {
    ...createFakeConversationService(),
    appendMessage: async () => {
      calls.push("appendMessage");
      return { id: "msg-1" };
    },
  };
}

function trackingBudgetLedger(calls: string[]): BudgetLedger {
  return {
    ...createFakeBudgetLedger(),
    reserveChatInTransaction: async () => {
      calls.push("reserveChatInTransaction");
      return true;
    },
  };
}

describe("§20.5: admissão do chat por bucket atômico", () => {
  it("recusa com RATE_LIMIT (429) antes do orçamento e do histórico", async () => {
    installFakeDatabase({ rateLimitAllowed: false });
    const calls: string[] = [];
    const modelCaller: ModelCaller = async () => {
      calls.push("modelCaller");
      return contentResponse();
    };

    await expect(
      executeSendChatMessage({ message: "Olá" }, TEST_IDENTITY, {
        modelCaller,
        budgetLedger: trackingBudgetLedger(calls),
        conversationService: trackingConversationService(calls),
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429 });
    expect(calls).toEqual([]);
  });

  it("segue o turno quando o bucket aprova", async () => {
    installFakeDatabase();
    const calls: string[] = [];

    const result = await executeSendChatMessage({ message: "Olá" }, TEST_IDENTITY, {
      modelCaller: async () => contentResponse(),
      budgetLedger: trackingBudgetLedger(calls),
      conversationService: trackingConversationService(calls),
    });

    expect(result).toMatchObject({ kind: "complete", content: "Pronto!" });
    expect(calls).toEqual([
      "reserveChatInTransaction",
      // mensagem do usuário, depois a resposta persistida
      "appendMessage",
      "appendMessage",
    ]);
  });

  it("a janela é fixa em 10 min e o máximo segue AI_CHAT_LIMIT_PER_10_MINUTES", () => {
    expect(chatRateLimitRule()).toEqual({ window: 600, max: 20 });

    vi.stubEnv(CHAT_LIMIT_ENV, "7");
    expect(chatRateLimitRule()).toEqual({ window: 600, max: 7 });

    vi.stubEnv(CHAT_LIMIT_ENV, "0");
    expect(chatRateLimitRule()).toEqual({ window: 600, max: 20 });
  });
});
