import { describe, expect, it } from "vitest";
import type { RequestContext } from "@/lib/request-context";
import { DefaultConversationService } from "@/server/services/conversation.service";
import type {
  Conversation,
  ConversationMessageInput,
  ConversationMessageSummary,
  ConversationRepository,
  ConversationUpdate,
} from "@/server/repositories/conversation.repository";
import { contextWithRole } from "./helpers/request-context";

const conversation = {
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: "50000000-0000-4000-8000-000000000005",
  userId: "user-1",
  currentProductId: null,
  confirmedState: {},
  conversationState: "idle",
  stateUpdatedAt: new Date(),
  stateMetadata: null,
  resetAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as Conversation;

class FakeConversationRepository implements ConversationRepository {
  calls: string[] = [];
  lastMessageInput: ConversationMessageInput | undefined;
  lastUpdate: ConversationUpdate | undefined;

  async findForUser(_context: RequestContext): Promise<Conversation | undefined> {
    this.calls.push("findForUser");
    return conversation;
  }

  async getOrCreate(_context: RequestContext): Promise<Conversation> {
    this.calls.push("getOrCreate");
    return conversation;
  }

  async listMessages(
    _context: RequestContext,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<ConversationMessageSummary[]> {
    this.calls.push(`listMessages:${conversationId}:${options?.limit ?? "all"}`);
    return [
      {
        id: "00000000-0000-4000-8000-000000000002",
        role: "user",
        content: "oi",
        createdAt: new Date("2026-09-13T12:00:00.000Z"),
      },
    ];
  }

  async countRecentUserMessages(_context: RequestContext, since: Date): Promise<number> {
    this.calls.push(`countRecentUserMessages:${since.toISOString()}`);
    return 3;
  }

  async appendMessage(
    _context: RequestContext,
    input: ConversationMessageInput,
  ): Promise<{ id: string } | undefined> {
    this.calls.push("appendMessage");
    this.lastMessageInput = input;
    return { id: "00000000-0000-4000-8000-000000000003" };
  }

  async updateConversation(
    _context: RequestContext,
    conversationId: string,
    changes: ConversationUpdate,
  ): Promise<void> {
    this.calls.push(`updateConversation:${conversationId}`);
    this.lastUpdate = changes;
  }

  async deleteMessages(_context: RequestContext, conversationId: string): Promise<void> {
    this.calls.push(`deleteMessages:${conversationId}`);
  }

  async findProduct(): Promise<{ id: string } | null> {
    this.calls.push("findProduct");
    return { id: "00000000-0000-4000-8000-000000000004" };
  }

  async validateProduct(
    _context: RequestContext,
    productId: string | null,
  ): Promise<string | null> {
    this.calls.push(`validateProduct:${productId ?? "null"}`);
    return productId;
  }
}

describe("ConversationService", () => {
  it("delega findForUser e getOrCreate ao repository", async () => {
    const repository = new FakeConversationRepository();
    const service = new DefaultConversationService(repository);
    const context = contextWithRole("owner");

    await expect(service.findForUser(context)).resolves.toBe(conversation);
    await expect(service.getOrCreate(context)).resolves.toBe(conversation);
    expect(repository.calls).toEqual(["findForUser", "getOrCreate"]);
  });

  it("delega listMessages preservando conversationId e limite", async () => {
    const repository = new FakeConversationRepository();
    const service = new DefaultConversationService(repository);

    const summary = await service.listMessages(contextWithRole("owner"), conversation.id, {
      limit: 60,
    });

    expect(summary).toHaveLength(1);
    expect(repository.calls).toEqual([`listMessages:${conversation.id}:60`]);
  });

  it("delega countRecentUserMessages com a janela recebida", async () => {
    const repository = new FakeConversationRepository();
    const service = new DefaultConversationService(repository);
    const since = new Date("2026-09-13T12:00:00.000Z");

    await expect(service.countRecentUserMessages(contextWithRole("owner"), since)).resolves.toBe(3);
    expect(repository.calls).toEqual([`countRecentUserMessages:${since.toISOString()}`]);
  });

  it("delega appendMessage com metadados opcionais", async () => {
    const repository = new FakeConversationRepository();
    const service = new DefaultConversationService(repository);

    const saved = await service.appendMessage(contextWithRole("owner"), {
      conversationId: conversation.id,
      role: "assistant",
      content: "resposta",
      metadata: { currentProductId: null },
    });

    expect(saved).toEqual({ id: "00000000-0000-4000-8000-000000000003" });
    expect(repository.lastMessageInput).toEqual({
      conversationId: conversation.id,
      role: "assistant",
      content: "resposta",
      metadata: { currentProductId: null },
    });
  });

  it("delega updateConversation e deleteMessages sem reescrever mudanças", async () => {
    const repository = new FakeConversationRepository();
    const service = new DefaultConversationService(repository);
    const changes: ConversationUpdate = {
      conversationState: "collecting_context",
      stateUpdatedAt: new Date("2026-09-13T12:00:00.000Z"),
    };

    await service.updateConversation(contextWithRole("owner"), conversation.id, changes);
    await service.deleteMessages(contextWithRole("owner"), conversation.id);

    expect(repository.lastUpdate).toBe(changes);
    expect(repository.calls).toEqual([
      `updateConversation:${conversation.id}`,
      `deleteMessages:${conversation.id}`,
    ]);
  });

  it("delega findProduct e validateProduct sem curto-circuito no service", async () => {
    const repository = new FakeConversationRepository();
    const service = new DefaultConversationService(repository);
    const context = contextWithRole("owner");

    await expect(service.findProduct(context, "product-1")).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000004",
    });
    await expect(service.validateProduct(context, null)).resolves.toBeNull();
    expect(repository.calls).toEqual(["findProduct", "validateProduct:null"]);
  });
});
