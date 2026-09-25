import { describe, expect, it } from "vitest";
import { chatStatusLabel, isChatBusy, transitionChatState } from "@/lib/chat-fsm";

describe("chat FSM", () => {
  it("mantém transições explícitas e não mostra digitação depois de uma falha", () => {
    let state = transitionChatState("idle", { type: "SUBMIT" });
    expect(state).toBe("thinking");
    state = transitionChatState(state, { type: "TOOL_CALL" });
    expect(state).toBe("tool_calling");
    state = transitionChatState(state, { type: "FAIL" });
    expect(state).toBe("error");
    expect(isChatBusy(state)).toBe(false);
    expect(chatStatusLabel(state)).toContain("concluir");
  });

  it("volta a aguardar o usuário após resposta e permite reinício", () => {
    expect(transitionChatState("thinking", { type: "ASSISTANT_RESPONSE" })).toBe("waiting_user");
    expect(transitionChatState("waiting_user", { type: "RESET" })).toBe("idle");
  });
});
