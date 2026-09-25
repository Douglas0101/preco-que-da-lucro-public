import { and, asc, count, eq, gte } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { chatConversations, chatMessages, products } from "@/db/schema";
import { ApplicationError } from "@/lib/api-error";
import type { RequestContext } from "@/lib/request-context";

export type Conversation = typeof chatConversations.$inferSelect;
export type ConversationMessage = typeof chatMessages.$inferSelect;
export type ConversationMessageSummary = Pick<
  ConversationMessage,
  "id" | "role" | "content" | "createdAt"
>;

export interface ConversationMessageInput {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationUpdate {
  currentProductId?: string | null;
  confirmedState?: Record<string, unknown>;
  conversationState?: string;
  stateUpdatedAt?: Date;
  stateMetadata?: Record<string, unknown>;
  resetAt?: Date;
  updatedAt?: Date;
}

export interface ConversationRepository {
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

export class DrizzleConversationRepository implements ConversationRepository {
  /** Read-only lookup used by GET handlers. GET must never create tenant data. */
  async findForUser(context: RequestContext): Promise<Conversation | undefined> {
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    const [existing] = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.tenantId, context.tenantId),
          eq(chatConversations.userId, context.userId),
        ),
      )
      .limit(1);
    return existing;
  }

  /** Creation is intentionally isolated to POST flows (send/reset/explicit create). */
  async getOrCreate(context: RequestContext): Promise<Conversation> {
    const tx = context.transaction as DatabaseTransaction;
    const inserted = await tx
      .insert(chatConversations)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        confirmedState: {},
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return inserted[0];

    const existing = await this.findForUser(context);
    if (!existing) throw new Error("DATABASE_ERROR");
    return existing;
  }

  listMessages(
    context: RequestContext,
    conversationId: string,
    options: { limit?: number } = {},
  ): Promise<ConversationMessageSummary[]> {
    const tx = context.transaction as DatabaseTransaction;
    const query = tx
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.tenantId, context.tenantId),
          eq(chatMessages.conversationId, conversationId),
        ),
      )
      .orderBy(asc(chatMessages.createdAt));
    return options.limit === undefined ? query : query.limit(options.limit);
  }

  async countRecentUserMessages(context: RequestContext, since: Date): Promise<number> {
    const tx = context.transaction as DatabaseTransaction;
    const [recent] = await tx
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.tenantId, context.tenantId),
          eq(chatMessages.userId, context.userId),
          eq(chatMessages.role, "user"),
          gte(chatMessages.createdAt, since),
        ),
      );
    return recent?.value ?? 0;
  }

  async appendMessage(
    context: RequestContext,
    input: ConversationMessageInput,
  ): Promise<{ id: string } | undefined> {
    const tx = context.transaction as DatabaseTransaction;
    const [saved] = await tx
      .insert(chatMessages)
      .values({
        conversationId: input.conversationId,
        tenantId: context.tenantId,
        userId: context.userId,
        role: input.role,
        content: input.content,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      })
      .returning({ id: chatMessages.id });
    return saved;
  }

  async updateConversation(
    context: RequestContext,
    conversationId: string,
    changes: ConversationUpdate,
  ): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    await tx
      .update(chatConversations)
      .set(changes)
      .where(
        and(
          eq(chatConversations.tenantId, context.tenantId),
          eq(chatConversations.id, conversationId),
        ),
      );
  }

  async deleteMessages(context: RequestContext, conversationId: string): Promise<void> {
    const tx = context.transaction as DatabaseTransaction;
    await tx
      .delete(chatMessages)
      .where(
        and(
          eq(chatMessages.tenantId, context.tenantId),
          eq(chatMessages.conversationId, conversationId),
        ),
      );
  }

  async findProduct(context: RequestContext, productId: string): Promise<{ id: string } | null> {
    const tx = context.transaction as DatabaseTransaction;
    const [row] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, context.tenantId), eq(products.id, productId)))
      .limit(1);
    return row ?? null;
  }

  async validateProduct(context: RequestContext, productId: string | null): Promise<string | null> {
    if (!productId) return null;
    const row = await this.findProduct(context, productId);
    if (!row) throw new ApplicationError("NOT_FOUND");
    return row.id;
  }
}

export const conversationRepository = new DrizzleConversationRepository();
