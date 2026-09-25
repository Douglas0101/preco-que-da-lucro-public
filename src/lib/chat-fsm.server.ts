import { REGISTRY_TOOL_NAMES } from "@/lib/ai/tool-registry";

/**
 * Server-side conversational FSM (plan WS-06 §5.6.2). Unlike the client-side
 * UI FSM in {@link ../../lib/chat-fsm}, this state machine persists the
 * conversation phase in `chat_conversations` and drives the tool allowlist.
 */
export type ConversationState =
  | "idle"
  | "collecting_context"
  /** RESERVA (ADR-026): inalcançável no fluxo executado; permitir entrada apenas por escrita futura (M-04). Allowlist vazia = gate negation server-side. */
  | "calculating"
  /** RESERVA (ADR-026): inalcançável no fluxo executado; permitir entrada apenas por escrita futura (M-04). Allowlist vazia = gate negation server-side. */
  | "confirming"
  /** RESERVA (ADR-026): inalcançável no fluxo executado; permitir entrada apenas por escrita futura (M-04). Allowlist vazia = gate negation server-side. */
  | "executing"
  | "completed"
  | "failed";

export type ConversationEvent = "SUBMIT" | "TOOL_EXECUTED" | "FINAL" | "FAILED" | "RESET";

export const CONVERSATION_STATES: readonly ConversationState[] = [
  "idle",
  "collecting_context",
  "calculating",
  "confirming",
  "executing",
  "completed",
  "failed",
];

export const CONVERSATION_EVENTS: readonly ConversationEvent[] = [
  "SUBMIT",
  "TOOL_EXECUTED",
  "FINAL",
  "FAILED",
  "RESET",
];

const transitions: Record<
  ConversationState,
  Partial<Record<ConversationEvent, ConversationState>>
> = {
  idle: { SUBMIT: "collecting_context", RESET: "idle" },
  collecting_context: {
    TOOL_EXECUTED: "collecting_context",
    FINAL: "completed",
    FAILED: "failed",
    SUBMIT: "collecting_context",
    RESET: "idle",
  },
  /**
   * RESERVA (ADR-026): nenhum estado do grafo executado tem aresta de ENTRADA
   * para calculating/confirming/executing; são inalcançáveis por eventos. As
   * arestas de saída abaixo (FINAL/FAILED/RESET) são guardas inofensivos para o
   * caso de uma escrita direta futura (protocolo de confirmação M-04/P2).
   */
  calculating: { FINAL: "completed", FAILED: "failed", RESET: "idle" },
  confirming: { FINAL: "completed", FAILED: "failed", RESET: "idle" },
  executing: { FINAL: "completed", FAILED: "failed", RESET: "idle" },
  completed: { SUBMIT: "collecting_context", RESET: "idle" },
  failed: { SUBMIT: "collecting_context", RESET: "idle" },
};

export function isTransitionAllowed(state: ConversationState, event: ConversationEvent): boolean {
  return transitions[state][event] !== undefined;
}

/**
 * Returns the target state, or the same state when the transition is not
 * defined in the table (the caller flags the invalid transition via metric).
 */
export function transitionConversationState(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  return transitions[state][event] ?? state;
}

export function conversationStateLabel(state: ConversationState): string | null {
  switch (state) {
    case "collecting_context":
      return "Coletando contexto do produto";
    case "calculating":
      return "Calculando cenários de preço";
    case "confirming":
      return "Confirmando dados coletados";
    case "executing":
      return "Executando ações confirmadas";
    case "failed":
      return "Não foi possível concluir a conversa";
    default:
      return null;
  }
}

export function isConversationState(value: unknown): value is ConversationState {
  return typeof value === "string" && (CONVERSATION_STATES as readonly string[]).includes(value);
}

/**
 * Tool allowlist per conversation state. Only `collecting_context` may run
 * tools; the product-scope rule (gatewayToolsForState) is enforced separately
 * by the guarded tool runner in chat-execution.
 *
 * ADR-026: this is the single mutation-authorizing state in the executed
 * graph — the whole registry (10 tools) is exposed there (still gated by
 * product scope, role/canMutate and per-call idempotency in the runner). The
 * RESERVED states (`calculating`/`confirming`/`executing`) keep empty lists:
 * reaching one by direct DB write would not authorize any tool (gate
 * negation). Confirmation stays conversational; INV-009 compensation is the
 * idempotency key + tool_executions ledger in chat-execution.
 */
export const FSM_STATE_TOOL_ALLOWLIST: Record<ConversationState, readonly string[]> = {
  idle: [],
  collecting_context: REGISTRY_TOOL_NAMES,
  calculating: [],
  confirming: [],
  executing: [],
  completed: [],
  failed: [],
};
