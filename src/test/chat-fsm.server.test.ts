import { describe, expect, it } from "vitest";
import {
  CONVERSATION_EVENTS,
  CONVERSATION_STATES,
  FSM_STATE_TOOL_ALLOWLIST,
  conversationStateLabel,
  isConversationState,
  isTransitionAllowed,
  transitionConversationState,
} from "@/lib/chat-fsm.server";
import { REGISTRY_TOOL_NAMES, TOOL_REGISTRY } from "@/lib/ai/tool-registry";

describe("FSM de conversa (servidor)", () => {
  it("inicia e evolui idle → collecting_context → completed", () => {
    expect(transitionConversationState("idle", "SUBMIT")).toBe("collecting_context");
    expect(transitionConversationState("collecting_context", "TOOL_EXECUTED")).toBe(
      "collecting_context",
    );
    expect(transitionConversationState("collecting_context", "FINAL")).toBe("completed");
  });

  it("volta a coletar contexto a partir de completed e failed", () => {
    expect(transitionConversationState("completed", "SUBMIT")).toBe("collecting_context");
    expect(transitionConversationState("failed", "SUBMIT")).toBe("collecting_context");
  });

  it("reinicia qualquer estado para idle com RESET", () => {
    for (const state of CONVERSATION_STATES) {
      expect(transitionConversationState(state, "RESET")).toBe("idle");
    }
  });

  it("falha os estados de coleta/cálculo/confirmação/execução", () => {
    expect(transitionConversationState("collecting_context", "FAILED")).toBe("failed");
    expect(transitionConversationState("calculating", "FAILED")).toBe("failed");
    expect(transitionConversationState("confirming", "FAILED")).toBe("failed");
    expect(transitionConversationState("executing", "FAILED")).toBe("failed");
  });

  it("marca transições indefinidas como inválidas e retorna o estado inalterado", () => {
    expect(isTransitionAllowed("idle", "FINAL")).toBe(false);
    expect(transitionConversationState("idle", "FINAL")).toBe("idle");
    expect(isTransitionAllowed("completed", "TOOL_EXECUTED")).toBe(false);
    expect(transitionConversationState("failed", "FINAL")).toBe("failed");
  });

  it("sustenta todos os estados e eventos declarados", () => {
    expect(CONVERSATION_STATES).toHaveLength(7);
    expect(CONVERSATION_EVENTS).toHaveLength(5);
    for (const state of CONVERSATION_STATES) {
      expect(isConversationState(state)).toBe(true);
    }
    expect(isConversationState("não-existe")).toBe(false);
    expect(conversationStateLabel("idle")).toBeNull();
    expect(conversationStateLabel("collecting_context")).toContain("Coletando");
  });
});

describe("allowlist de tools por estado do FSM servidor", () => {
  it("permite todas as tools registradas apenas em collecting_context", () => {
    expect(FSM_STATE_TOOL_ALLOWLIST.collecting_context).toEqual(REGISTRY_TOOL_NAMES);
    expect(FSM_STATE_TOOL_ALLOWLIST.collecting_context).toHaveLength(TOOL_REGISTRY.size);
  });

  it("nega tools em todos os demais estados", () => {
    for (const state of CONVERSATION_STATES) {
      if (state === "collecting_context") continue;
      expect(FSM_STATE_TOOL_ALLOWLIST[state]).toEqual([]);
    }
  });

  it("classifica toda tool registrada sem órfãos", () => {
    const classified = new Set(FSM_STATE_TOOL_ALLOWLIST.collecting_context);
    for (const name of TOOL_REGISTRY.keys()) {
      expect(classified.has(name), `tool não classificada: ${name}`).toBe(true);
    }
  });
});

// ADR-026: o grafo EXECUTADO é idle → collecting_context → completed | failed
// (mais SUBMIT/RESET); calculating/confirming/executing são RESERVADOS —
// nenhuma aresta de entrada por evento, allowlist vazia = gate negation.
const RESERVED_STATES = ["calculating", "confirming", "executing"] as const;

describe("grafo executado da FSM (ADR-026)", () => {
  it("percorre SUBMIT → TOOL_EXECUTED* → FINAL sem transições inválidas", () => {
    let state = transitionConversationState("idle", "SUBMIT");
    expect(state).toBe("collecting_context");
    // self-loop de tools (uma ou mais rodadas) — sempre válido, sempre coleta
    for (const _ of [0, 1, 2]) {
      expect(isTransitionAllowed(state, "TOOL_EXECUTED")).toBe(true);
      state = transitionConversationState(state, "TOOL_EXECUTED");
      expect(state).toBe("collecting_context");
    }
    expect(isTransitionAllowed(state, "FINAL")).toBe(true);
    state = transitionConversationState(state, "FINAL");
    expect(state).toBe("completed");
  });

  it("reativa a coleta a partir de completed e failed sem transição inválida", () => {
    expect(isTransitionAllowed("completed", "SUBMIT")).toBe(true);
    expect(transitionConversationState("completed", "SUBMIT")).toBe("collecting_context");
    expect(isTransitionAllowed("collecting_context", "FAILED")).toBe(true);
    expect(transitionConversationState("collecting_context", "FAILED")).toBe("failed");
    expect(isTransitionAllowed("failed", "SUBMIT")).toBe(true);
    expect(transitionConversationState("failed", "SUBMIT")).toBe("collecting_context");
  });

  it("não possui aresta de entrada para os estados reservados a partir do grafo executado", () => {
    const executedStates = ["idle", "collecting_context", "completed", "failed"] as const;
    for (const source of executedStates) {
      for (const event of CONVERSATION_EVENTS) {
        const target = transitionConversationState(source, event);
        expect(
          (RESERVED_STATES as readonly string[]).includes(target),
          `${source} --${event}--> ${target} não deveria alcançar reservado`,
        ).toBe(false);
      }
    }
  });
});

describe("estados reservados da FSM (ADR-026)", () => {
  it("têm allowlist vazia (nenhuma tool mutante autorizada)", () => {
    for (const state of RESERVED_STATES) {
      expect(FSM_STATE_TOOL_ALLOWLIST[state], `allowlist de ${state}`).toEqual([]);
    }
  });

  it("só expõem arestas de saída de guarda (FINAL/FAILED/RESET); demais eventos são inválidos", () => {
    for (const state of RESERVED_STATES) {
      // guardas de escrita direta futura: permitem sair do estado reservado
      expect(transitionConversationState(state, "FINAL")).toBe("completed");
      expect(transitionConversationState(state, "FAILED")).toBe("failed");
      expect(transitionConversationState(state, "RESET")).toBe("idle");
      // sem entrada por evento: SUBMIT/TOOL_EXECUTED não são definidos (in-place)
      expect(isTransitionAllowed(state, "SUBMIT")).toBe(false);
      expect(transitionConversationState(state, "SUBMIT")).toBe(state);
      expect(isTransitionAllowed(state, "TOOL_EXECUTED")).toBe(false);
      expect(transitionConversationState(state, "TOOL_EXECUTED")).toBe(state);
    }
  });
});
