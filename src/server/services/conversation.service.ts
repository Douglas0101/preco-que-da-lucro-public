import type { RequestContext } from "@/lib/request-context";
import {
  conversationRepository,
  type Conversation,
  type ConversationMessageInput,
  type ConversationMessageSummary,
  type ConversationRepository,
  type ConversationUpdate,
} from "@/server/repositories/conversation.repository";

export interface ConversationService {
  findForUser(context: RequestContext): Promise<Conversation | undefined>;
  getOrCreate(context: RequestContext): Promise<Conversation>;
  listMessages(
    context: RequestContext,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<ConversationMessageSummary[]>;
  countRecentUserMessages(context: RequestContext, since: Date): Promise<number>;
  appendMessage(
    context: RequestContext,
    input: ConversationMessageInput,
  ): Promise<{ id: string } | undefined>;
  updateConversation(
    context: RequestContext,
    conversationId: string,
    changes: ConversationUpdate,
  ): Promise<void>;
  deleteMessages(context: RequestContext, conversationId: string): Promise<void>;
  findProduct(context: RequestContext, productId: string): Promise<{ id: string } | null>;
  validateProduct(context: RequestContext, productId: string | null): Promise<string | null>;
}

export class DefaultConversationService implements ConversationService {
  constructor(private readonly repository: ConversationRepository) {}

  findForUser(context: RequestContext): Promise<Conversation | undefined> {
    return this.repository.findForUser(context);
  }

  getOrCreate(context: RequestContext): Promise<Conversation> {
    return this.repository.getOrCreate(context);
  }

  listMessages(
    context: RequestContext,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<ConversationMessageSummary[]> {
    return this.repository.listMessages(context, conversationId, options);
  }

  countRecentUserMessages(context: RequestContext, since: Date): Promise<number> {
    return this.repository.countRecentUserMessages(context, since);
  }

  appendMessage(
    context: RequestContext,
    input: ConversationMessageInput,
  ): Promise<{ id: string } | undefined> {
    return this.repository.appendMessage(context, input);
  }

  updateConversation(
    context: RequestContext,
    conversationId: string,
    changes: ConversationUpdate,
  ): Promise<void> {
    return this.repository.updateConversation(context, conversationId, changes);
  }

  deleteMessages(context: RequestContext, conversationId: string): Promise<void> {
    return this.repository.deleteMessages(context, conversationId);
  }

  findProduct(context: RequestContext, productId: string): Promise<{ id: string } | null> {
    return this.repository.findProduct(context, productId);
  }

  validateProduct(context: RequestContext, productId: string | null): Promise<string | null> {
    return this.repository.validateProduct(context, productId);
  }
}

export const conversationService: ConversationService = new DefaultConversationService(
  conversationRepository,
);
