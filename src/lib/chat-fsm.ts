export type ChatState = "idle" | "thinking" | "tool_calling" | "waiting_user" | "error";

export type ChatEvent =
  | { type: "SUBMIT" }
  | { type: "TOOL_CALL" }
  | { type: "ASSISTANT_RESPONSE" }
  | { type: "FAIL" }
  | { type: "RESET" };

const transitions: Record<ChatState, Partial<Record<ChatEvent["type"], ChatState>>> = {
  idle: { SUBMIT: "thinking", RESET: "idle" },
  thinking: {
    TOOL_CALL: "tool_calling",
    ASSISTANT_RESPONSE: "waiting_user",
    FAIL: "error",
    RESET: "idle",
  },
  tool_calling: {
    TOOL_CALL: "tool_calling",
    ASSISTANT_RESPONSE: "waiting_user",
    FAIL: "error",
    RESET: "idle",
  },
  waiting_user: { SUBMIT: "thinking", RESET: "idle" },
  error: { SUBMIT: "thinking", RESET: "idle" },
};

export function transitionChatState(state: ChatState, event: ChatEvent): ChatState {
  return transitions[state][event.type] ?? state;
}

export function isChatBusy(state: ChatState): boolean {
  return state === "thinking" || state === "tool_calling";
}

export function chatStatusLabel(state: ChatState): string | null {
  switch (state) {
    case "thinking":
      return "Consultor pensando";
    case "tool_calling":
      return "Consultor atualizando seus dados";
    case "error":
      return "Não foi possível concluir a conversa";
    default:
      return null;
  }
}
