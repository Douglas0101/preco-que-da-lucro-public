import { withTenantTransaction } from "@/db/client.server";
import { ApplicationError } from "@/lib/api-error";
import {
  budgetConfigFromEnv,
  createBudgetLedger,
  estimateModelCost,
  type BudgetLedger,
  type BudgetLedgerConfig,
  type EstimatedCostResult,
  type SettlementUsage,
} from "@/lib/ai/budget-ledger.server";
import { parseAiUsage, type TokenUsage } from "@/lib/ai/token-usage";
import { gatewayToolsForState, type GatewayTool } from "@/lib/ai/tool-registry";
import { sanitizeAiOutput } from "@/lib/ai/output-sanitizer";
import { runRegisteredTool } from "@/lib/ai/tool-runner";
import {
  FSM_STATE_TOOL_ALLOWLIST,
  isConversationState,
  isTransitionAllowed,
  transitionConversationState,
  type ConversationEvent,
  type ConversationState,
} from "@/lib/chat-fsm.server";
import { applicationMetrics, withSpan } from "@/instrumentation/telemetry";
import type { DatabaseTransaction } from "@/db/client.server";
import { recordSafely } from "@/instrumentation/safe-record";
import { createTenantTransaction, numberSetting } from "@/lib/tenant-transaction";
import type { RequestContext, RequestIdentity } from "@/lib/request-context";
import {
  conversationService as defaultConversationService,
  type ConversationService,
} from "@/server/services/conversation.service";
import { USER_RATE_LIMIT_RULES, userRateLimitKey } from "@/server/auth/rate-limit-rules.server";
import {
  consumeRateLimitInTransaction,
  type RateLimitRule,
} from "@/server/auth/rate-limit-storage.server";
import { logJson } from "@/lib/structured-logger";

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

interface GatewayResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: GatewayToolCall[];
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const SYSTEM_PROMPT = `Você é o "Consultor Preço que Dá Lucro", uma IA amiga e didática que ajuda pequenos empreendedores brasileiros a coletarem dados e avaliarem cenários de preço.

REGRAS INEGOCIÁVEIS:
1) Converse em português do Brasil, com linguagem simples e uma pergunta por vez.
2) Nunca faça cálculos matemáticos; o motor financeiro determinístico faz os cálculos.
3) Nunca invente preço, custo, alíquota ou imposto. Ausência continua ausente, nunca zero.
4) Confirme o entendimento antes de chamar uma ferramenta de mutação.
5) Use somente as ferramentas registradas e explique apenas o resultado seguro recebido.
6) Não solicite senha, token, documento pessoal ou credencial.
7) Apresente valores financeiros no padrão do Brasil: moeda como R$ 1.234,56 e decimais/percentuais com vírgula (ex.: 12,5%).
8) É vedado inventar, arredondar ou somar valores não fornecidos pelo usuário ou pelo motor financeiro; exiba o valor recebido sem alterar o número.

FLUXO: create_product; add_ingredients; set_ingredient_cost para cada ingrediente; set_yield; add_packaging; set_price_and_tax; add_fee; set_market_price; finish_product.
Ao explicar, use "vale investigar", "os dados indicam" e "pode ser interessante simular". Não afirme que um preço está certo ou errado sem contexto.`;

export interface SendChatMessageInput {
  message: string;
  currentProductId?: string | null;
}

export type ModelCaller = (
  messages: GatewayMessage[],
  tools: GatewayTool[],
  requestSignal: AbortSignal,
) => Promise<GatewayResponse>;

export type ToolRunner = (
  options: Parameters<typeof runRegisteredTool>[0],
) => ReturnType<typeof runRegisteredTool>;

export interface ChatExecutionDependencies {
  modelCaller: ModelCaller;
  budgetLedger?: BudgetLedger;
  budgetConfig?: Partial<BudgetLedgerConfig>;
  toolRunner?: ToolRunner;
  conversationService?: ConversationService;
}

const inTenantTransaction = createTenantTransaction(withTenantTransaction);

/**
 * Chat bucket (§20.5). The window comes from USER_RATE_LIMIT_RULES; the max
 * stays operator-tunable through AI_CHAT_LIMIT_PER_10_MINUTES (default 20), the
 * same variable that drove the previous count of persisted user messages.
 */
export function chatRateLimitRule(): RateLimitRule {
  return {
    window: USER_RATE_LIMIT_RULES.chat.window,
    max: numberSetting("AI_CHAT_LIMIT_PER_10_MINUTES", USER_RATE_LIMIT_RULES.chat.max, 1, 1_000),
  };
}

async function reserveChatAndLoadHistory(
  context: RequestContext,
  budgetLedger: BudgetLedger,
  conversationService: ConversationService,
  message: string,
  requestedProductId: string | null,
) {
  // §9.2 — o handle neutro do contexto é estreitado aqui: rate limit e
  // orçamento são APIs de adapter (transação do driver).
  const tx = context.transaction as DatabaseTransaction;
  // Admission (§20.5) before any side effect of the turn: the bucket is atomic
  // and shared by every instance, unlike the previous count of persisted user
  // messages, which two concurrent turns could both pass. Denied turns burn no
  // AI quota because this runs before the budget reservation.
  const admission = await consumeRateLimitInTransaction(
    tx,
    userRateLimitKey("chat", context.userId),
    chatRateLimitRule(),
  );
  if (!admission.allowed) {
    logJson("warn", "ai.chat_rate_limited", {
      bucket: "chat",
      retryAfterSeconds: admission.retryAfter,
    });
    throw new ApplicationError("RATE_LIMIT");
  }

  const chatReserved = await budgetLedger.reserveChatInTransaction(tx, context.tenantId);
  if (!chatReserved) throw new ApplicationError("AI_QUOTA");

  const conversation = await conversationService.getOrCreate(context);
  const currentProductId = await conversationService.validateProduct(
    context,
    requestedProductId ?? conversation.currentProductId,
  );
  await conversationService.appendMessage(context, {
    conversationId: conversation.id,
    role: "user",
    content: message,
  });
  const history = await conversationService.listMessages(context, conversation.id, { limit: 60 });
  const conversationState: ConversationState = isConversationState(conversation.conversationState)
    ? conversation.conversationState
    : "idle";
  return { conversation, currentProductId, history, conversationState };
}

function settlementOutcome(error: unknown): string {
  if (error instanceof ApplicationError) return `error_${error.code.toLowerCase()}`;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "error";
}

interface ChatState {
  conversation: { id: string };
  currentProductId: string | null;
  history: Array<{ role: string; content: string }>;
  conversationState: ConversationState;
}

/**
 * §29: fases da latência do chat não-streaming, medidas desde o aceite da
 * mensagem do usuário (`startedAt`) até: primeira resposta do gateway
 * (`time_to_acknowledge`, mesmo que seja tool call), primeiro conteúdo
 * (`time_to_first_content`) e resposta final (`time_to_final`). Sem streaming,
 * conteúdo e final chegam na mesma resposta do gateway; os dois histogramas
 * permanecem separados para receber streaming sem renomear série.
 */
interface ChatLatencyTracker {
  startedAt: number;
  acknowledgedAt: number | null;
}

function createChatLatencyTracker(startedAt: number): ChatLatencyTracker {
  return { startedAt, acknowledgedAt: null };
}

/** Registra uma única vez o primeiro modelo retornado pelo gateway. */
function acknowledgeGatewayResponse(latency: ChatLatencyTracker): void {
  if (latency.acknowledgedAt !== null) return;
  latency.acknowledgedAt = performance.now();
  recordSafely(applicationMetrics.aiTimeToAcknowledge, latency.acknowledgedAt - latency.startedAt);
}

function timeToAcknowledgeMs(latency: ChatLatencyTracker): number | null {
  return latency.acknowledgedAt === null
    ? null
    : Math.round(latency.acknowledgedAt - latency.startedAt);
}

type RoundResult =
  | { kind: "continue"; currentProductId: string | null }
  | { kind: "complete"; content: string; currentProductId: string | null };

function buildInitialMessages(state: ChatState): GatewayMessage[] {
  const messages: GatewayMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (state.currentProductId) {
    messages.push({
      role: "system",
      content: `O produto atual confirmado tem id "${state.currentProductId}".`,
    });
  }
  for (const message of state.history) {
    if (message.role === "user" || message.role === "assistant" || message.role === "system") {
      messages.push({ role: message.role, content: message.content });
    }
  }
  return messages;
}

async function persistAssistantMessage(
  conversationService: ConversationService,
  identity: RequestIdentity,
  state: ChatState,
  currentProductId: string | null,
  content: string,
): Promise<void> {
  await inTenantTransaction(identity, async (request) => {
    const saved = await conversationService.appendMessage(request, {
      conversationId: state.conversation.id,
      role: "assistant",
      content,
      metadata: { currentProductId },
    });
    await conversationService.updateConversation(request, state.conversation.id, {
      currentProductId,
      confirmedState: {
        currentProductId,
        lastAssistantMessageId: saved?.id ?? null,
        lastConfirmedAt: new Date().toISOString(),
      },
      conversationState: state.conversationState,
      stateUpdatedAt: new Date(),
      updatedAt: new Date(),
    });
  });
}

async function persistConversationState(
  conversationService: ConversationService,
  identity: RequestIdentity,
  conversationId: string,
  conversationState: ConversationState,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await inTenantTransaction(identity, async (request) => {
    await conversationService.updateConversation(request, conversationId, {
      conversationState,
      stateUpdatedAt: new Date(),
      ...(metadata === undefined ? {} : { stateMetadata: metadata }),
    });
  });
}

/**
 * Applies an FSM transition: records the metric, persists the new state when
 * it differs, and never throws for invalid transitions (returns state as-is).
 */
async function transitionConversation(
  conversationService: ConversationService,
  identity: RequestIdentity,
  conversationId: string,
  state: ConversationState,
  event: ConversationEvent,
  persist = true,
): Promise<ConversationState> {
  if (!isTransitionAllowed(state, event)) {
    applicationMetrics.conversationInvalidTransitions.add(1, { from: state, event });
    return state;
  }
  const next = transitionConversationState(state, event);
  applicationMetrics.conversationStateTransitions.add(1, { from: state, to: next });
  if (persist && next !== state) {
    await persistConversationState(conversationService, identity, conversationId, next);
  }
  return next;
}

/**
 * Per-round tool gate (WS-06): tools only run when the conversation state
 * allowlist and the product scope (gatewayToolsForState) both permit the call.
 */
function fsmGuardedToolRunner(
  getState: () => ConversationState,
  getProductId: () => string | null,
  inner: ToolRunner,
): ToolRunner {
  return async (options) => {
    const toolName = options.name;
    const state = getState();
    const scopedNames = new Set(
      gatewayToolsForState(getProductId()).map((tool) => tool.function.name),
    );
    if (!FSM_STATE_TOOL_ALLOWLIST[state].includes(toolName) || !scopedNames.has(toolName)) {
      applicationMetrics.toolExecutions.add(1, { tool: toolName, status: "blocked", state });
      logJson("warn", "ai.tool_blocked", { toolName, state });
      return { ok: false as const, code: "VALIDATION_ERROR" as const, replayed: false };
    }
    return inner(options);
  };
}

type ToolResult = Awaited<ReturnType<ToolRunner>>;

function toolMessage(toolCallId: string, toolResult: ToolResult): GatewayMessage {
  const content = toolResult.ok
    ? { ok: true, ...toolResult.output.result, replayed: toolResult.replayed }
    : { ok: false, error: { code: toolResult.code }, replayed: toolResult.replayed };
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(content) };
}

async function runToolCall(
  identity: RequestIdentity,
  conversationId: string,
  toolCall: GatewayToolCall,
  toolRunner: ToolRunner,
  usageId: string,
): Promise<ToolResult> {
  return inTenantTransaction(identity, (request) =>
    toolRunner({
      context: request,
      name: toolCall.function.name,
      rawArguments: toolCall.function.arguments,
      idempotencyKey: `${conversationId}:${toolCall.id}`,
      toolCallId: toolCall.id,
      usageId,
    }),
  );
}

async function appendToolCalls(
  messages: GatewayMessage[],
  identity: RequestIdentity,
  state: ChatState,
  currentProductId: string | null,
  toolCalls: GatewayToolCall[],
  toolRunner: ToolRunner,
  usageId: string,
): Promise<string | null> {
  let nextProductId = currentProductId;
  for (const toolCall of toolCalls) {
    const toolResult = await runToolCall(
      identity,
      state.conversation.id,
      toolCall,
      toolRunner,
      usageId,
    );
    if (toolResult.ok && toolResult.output.state?.currentProductId) {
      nextProductId = toolResult.output.state.currentProductId;
    }
    messages.push(toolMessage(toolCall.id, toolResult));
  }
  return nextProductId;
}

async function handleModelResponse(
  modelResponse: GatewayResponse,
  messages: GatewayMessage[],
  identity: RequestIdentity,
  state: ChatState,
  currentProductId: string | null,
  round: number,
  toolRunner: ToolRunner,
  conversationService: ConversationService,
  usageId: string,
  latency: ChatLatencyTracker,
): Promise<RoundResult> {
  const modelMessage = modelResponse.choices[0]!.message;
  const toolCalls = modelMessage.tool_calls;
  if (toolCalls?.length) {
    messages.push({
      role: "assistant",
      content: modelMessage.content ?? "",
      tool_calls: toolCalls,
    });
    const nextProductId = await appendToolCalls(
      messages,
      identity,
      state,
      currentProductId,
      toolCalls,
      toolRunner,
      usageId,
    );
    state.conversationState = await transitionConversation(
      conversationService,
      identity,
      state.conversation.id,
      state.conversationState,
      "TOOL_EXECUTED",
    );
    return { kind: "continue", currentProductId: nextProductId };
  }

  const content = modelMessage.content ? sanitizeAiOutput(modelMessage.content) : "";
  if (!content) throw new ApplicationError("DEPENDENCY_ERROR");
  state.conversationState = await transitionConversation(
    conversationService,
    identity,
    state.conversation.id,
    state.conversationState,
    "FINAL",
    false,
  );
  await persistAssistantMessage(conversationService, identity, state, currentProductId, content);
  // Sem streaming, o primeiro conteúdo e o final são a mesma resposta: os dois
  // registros saem daqui e devem permanecer iguais até existir streaming.
  const completedAt = performance.now();
  const timeToFirstContentMs = completedAt - latency.startedAt;
  const timeToFinalMs = timeToFirstContentMs;
  recordSafely(applicationMetrics.aiTimeToFirstContent, timeToFirstContentMs);
  recordSafely(applicationMetrics.aiTimeToFinal, timeToFinalMs);
  logJson("info", "ai.chat_completed", {
    correlationId: identity.correlationId,
    tenantId: identity.tenantId,
    rounds: round + 1,
    timeToAcknowledgeMs: timeToAcknowledgeMs(latency),
    timeToFirstContentMs: Math.round(timeToFirstContentMs),
    timeToFinalMs: Math.round(timeToFinalMs),
  });
  return { kind: "complete", content, currentProductId };
}

async function executeReservedRound({
  budgetLedger,
  budgetConfig,
  identity,
  messages,
  requestSignal,
  state,
  currentProductId,
  round,
  modelCaller,
  toolRunner,
  conversationService,
  latency,
}: {
  budgetLedger: BudgetLedger;
  budgetConfig: BudgetLedgerConfig;
  identity: RequestIdentity;
  messages: GatewayMessage[];
  requestSignal: AbortSignal;
  state: ChatState;
  currentProductId: string | null;
  round: number;
  modelCaller: ModelCaller;
  toolRunner: ToolRunner;
  conversationService: ConversationService;
  latency: ChatLatencyTracker;
}): Promise<RoundResult> {
  // reserveAtomic performs the lazy tenant sweep in the same transaction as the
  // conditional counter update. No gateway call can happen before this point.
  const reservationResult = await budgetLedger.reserveAtomic(
    identity.tenantId,
    budgetConfig.conservativeTokenBudget,
    { kind: "model", roundNo: round },
  );
  if (reservationResult.status !== "reserved") throw new ApplicationError("AI_QUOTA");

  // `null` significa que **nenhuma resposta foi recebida** (a chamada falhou antes de
  // medir). Isso NÃO é "uso desconhecido": sem resposta não há medição a classificar, e
  // o contrato legado da falha continua valendo (libera a reserva, registra o outcome do
  // erro). `TokenUsage` só é atribuído depois que o gateway respondeu.
  let usage: TokenUsage | null = null;
  let toolCallsCount = 0;
  let modelName: string | null = null;
  let outcome = "error";

  try {
    const modelResponse = await modelCaller(
      messages,
      gatewayToolsForState(currentProductId),
      requestSignal,
    );
    acknowledgeGatewayResponse(latency);
    modelName = (modelResponse as { model?: string }).model ?? null;
    // INV-006: absence of `usage` is unknown, never zero. The gateway envelope is
    // external input, so the classification happens once, here, and travels typed.
    usage = parseAiUsage((modelResponse as { usage?: unknown }).usage);
    toolCallsCount = modelResponse.choices[0]!.message.tool_calls?.length ?? 0;
    const result = await handleModelResponse(
      modelResponse,
      messages,
      identity,
      state,
      currentProductId,
      round,
      toolRunner,
      conversationService,
      reservationResult.usageId,
      latency,
    );
    outcome = result.kind === "continue" ? "tool_round" : "success";
    return result;
  } catch (error) {
    outcome = settlementOutcome(error);
    throw error;
  } finally {
    // Sem resposta do gateway (`usage === null`) não há medição a classificar: preserva-se
    // o contrato legado da falha — liquida com zero, libera a reserva e registra o outcome
    // do erro. "Uso desconhecido" fica reservado ao caso em que o gateway **respondeu** e o
    // `usage` não era utilizável (ausente/parcial/inválido).
    const settlementUsage: SettlementUsage = usage ?? 0;
    const est: EstimatedCostResult =
      usage?.kind === "known"
        ? estimateModelCost(modelName, usage.inputTokens, usage.outputTokens)
        : usage === null
          ? // Caminho de falha: o estimador é alimentado com zero exatamente como antes
            // desta mudança, para não alterar as métricas de custo de chamadas que falharam.
            estimateModelCost(modelName, 0, 0)
          : // Resposta recebida sem medição confiável: nenhum custo é afirmado.
            { cost: null, status: "unknown" };
    await budgetLedger.settle(reservationResult.usageId, settlementUsage, outcome, {
      ...(usage?.kind === "known"
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : {}),
      toolCalls: toolCallsCount,
      estimatedCost: est.cost,
      costStatus: est.status,
    });
    if (usage?.kind === "unknown") {
      // Auditable alarm: the state is persisted (real_tokens NULL + outcome
      // 'usage_unknown'), so this event is not the only trace of the unknown.
      logJson("warn", "ai.usage_unknown", {
        tenantId: identity.tenantId,
        usageId: reservationResult.usageId,
        reason: usage.reason,
        flowOutcome: outcome,
        model: modelName,
        round,
      });
    }
    try {
      if (usage?.kind === "unknown") {
        applicationMetrics.aiUsageUnknownTotal.add(1, { reason: usage.reason });
      }
      if (est.status === "known") {
        applicationMetrics.aiEstimatedCostTotal.add(1, {
          model: modelName ?? "unknown",
          status: "known",
        });
      } else if (est.status === "unknown") {
        applicationMetrics.aiCostUnknownTotal.add(1);
      }
    } catch (error) {
      // Cost telemetry must never break the chat settle path.
      logJson("warn", "ai.cost_metrics_failed", { error });
    }
  }
}

export async function executeSendChatMessage(
  data: SendChatMessageInput,
  identity: RequestIdentity,
  dependencies: ChatExecutionDependencies,
) {
  // t0 do §29: aceite da mensagem, antes de qualquer I/O (rate limit, histórico,
  // reserva de orçamento) — é a latência que o usuário percebe.
  const latency = createChatLatencyTracker(performance.now());
  const budgetConfig = { ...budgetConfigFromEnv(), ...dependencies.budgetConfig };
  const budgetLedger =
    dependencies.budgetLedger ?? createBudgetLedger({ identity, config: budgetConfig });
  const conversationService = dependencies.conversationService ?? defaultConversationService;
  const baseToolRunner = dependencies.toolRunner ?? runRegisteredTool;
  const requestTimeoutMs = numberSetting("AI_REQUEST_TIMEOUT_MS", 60_000, 1_000, 60_000);
  const requestSignal = AbortSignal.any([identity.signal, AbortSignal.timeout(requestTimeoutMs)]);

  if (requestSignal.aborted) throw new ApplicationError("AI_TIMEOUT");

  const loaded = await inTenantTransaction(identity, (request) =>
    reserveChatAndLoadHistory(
      request,
      budgetLedger,
      conversationService,
      data.message,
      data.currentProductId === undefined ? null : data.currentProductId,
    ),
  );
  const state: ChatState = {
    conversation: loaded.conversation,
    currentProductId: loaded.currentProductId,
    history: loaded.history,
    conversationState: loaded.conversationState,
  };
  let currentProductId = state.currentProductId;
  const toolRunner = fsmGuardedToolRunner(
    () => state.conversationState,
    () => currentProductId,
    baseToolRunner,
  );
  const messages = buildInitialMessages(state);
  const maxToolRounds = numberSetting("AI_MAX_TOOL_ROUNDS", 8, 1, 8);
  try {
    state.conversationState = await transitionConversation(
      conversationService,
      identity,
      state.conversation.id,
      state.conversationState,
      "SUBMIT",
    );
    return await withSpan(
      "ai.chat.send",
      { "app.ai.max_rounds": maxToolRounds },
      async (sendSpan) => {
        for (let round = 0; round < maxToolRounds; round += 1) {
          if (requestSignal.aborted) throw new ApplicationError("AI_TIMEOUT");
          const result = await withSpan(
            "ai.chat.round",
            { "app.ai.round_no": round },
            async (roundSpan) => {
              const roundResult = await executeReservedRound({
                budgetLedger,
                budgetConfig,
                identity,
                messages,
                requestSignal,
                state,
                currentProductId,
                round,
                modelCaller: dependencies.modelCaller,
                toolRunner,
                conversationService,
                latency,
              });
              roundSpan.setAttribute(
                "app.ai.outcome",
                roundResult.kind === "continue" ? "tool_round" : "success",
              );
              return roundResult;
            },
          );
          currentProductId = result.currentProductId;
          if (result.kind === "complete") {
            sendSpan.setAttribute("app.ai.outcome", "success");
            return result;
          }
        }

        throw new ApplicationError("DEPENDENCY_ERROR");
      },
    );
  } catch (error) {
    try {
      await transitionConversation(
        conversationService,
        identity,
        state.conversation.id,
        state.conversationState,
        "FAILED",
      );
    } catch (stateError) {
      logJson("warn", "ai.state_persist_failed", { error: stateError });
    }
    throw error;
  }
}

export function getConversationForTests(context: RequestContext) {
  return defaultConversationService.findForUser(context);
}
