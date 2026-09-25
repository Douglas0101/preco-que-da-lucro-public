import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeMemoryDedupKey,
  memoryDedupDiscriminator,
  normalizeMemoryContent,
  type MemoryDedupKeyInput,
} from "@/server/repositories/memory.repository";

/**
 * A chave de dedup (§15.6/D3, SD-C3-1) é a fronteira do dedup inteiro: se ela
 * não for determinística, o índice único parcial passa a recusar conteúdos que
 * deveriam coexistir (perda silenciosa) ou deixa duplicatas entrarem.
 *
 * Estes testes fixam a **forma** (sha256 hex do payload `scope ‖ 0x1f ‖
 * discriminador ‖ 0x1f ‖ conteúdo normalizado`), a normalização (NFC, trim,
 * colapso de espaços internos; caixa **não** normalizada) e o discriminador por
 * escopo. A prova contra o banco (o índice único decidindo a corrida) está em
 * `scripts/db/test-memory.ts` (D3/T1, T5, T6).
 */
const BASE_KEY_INPUT: MemoryDedupKeyInput = {
  scope: "tenant",
  content: "Preferência: relatórios semanais com margem por produto",
  userId: "user-1",
  conversationId: null,
};

/** Implementação independente da fórmula: se a do módulo mudar de forma (ordem,
 * separador, codificação), este teste acusa — não é um espelho do código. */
function expectedKey(scope: string, discriminator: string, content: string): string {
  return createHash("sha256")
    .update(`${scope}\u001f${discriminator}\u001f${content}`, "utf8")
    .digest("hex");
}

function key(overrides: Partial<MemoryDedupKeyInput> = {}): string {
  return computeMemoryDedupKey({ ...BASE_KEY_INPUT, ...overrides });
}

describe("normalizeMemoryContent — NFC + trim + colapso de espaços internos", () => {
  it("remove espaços das bordas e colapsa as sequências internas num espaço", () => {
    expect(normalizeMemoryContent("  a \t b\n\nc  ")).toBe("a b c");
    expect(normalizeMemoryContent("a\u00a0b")).toBe("a b");
  });

  it("normaliza a forma Unicode (NFC) sem mudar o texto", () => {
    expect(normalizeMemoryContent("cafe\u0301")).toBe("café");
    expect(normalizeMemoryContent("cafe\u0301")).toBe(normalizeMemoryContent("café"));
  });

  it("remove os caracteres de formatação invisíveis (categoria Cf) sem virar espaço", () => {
    // Os cinco citados no veredicto + dois vizinhos da MESMA categoria `Cf`
    // (o soft hyphen e o RIGHT-TO-LEFT MARK) para fixar que a limpeza é da
    // categoria inteira, não de uma lista de cinco literais.
    const invisibles = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u200f"];
    const clean = "relatórios semanais";
    for (const invisible of invisibles) {
      const code = `U+${invisible.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;
      // Dentro da palavra: o invisível some, NÃO vira separador.
      expect(normalizeMemoryContent(`rela${invisible}tórios semanais`), code).toBe(clean);
      // Nas bordas: o invisível não sobrevive ao `trim` (que só cobre espaços).
      expect(normalizeMemoryContent(` \u200b${clean}${invisible} `), code).toBe(clean);
      // E a chave acompanha a normalização: texto visualmente idêntico deduplica.
      expect(key({ content: `rela${invisible}tórios semanais` }), code).toBe(
        key({ content: clean }),
      );
    }
  });

  it("não transforma o invisível removido em espaço (o dedup não funde 'ab' com 'a b')", () => {
    expect(normalizeMemoryContent("a\u200bb")).toBe("ab");
    expect(normalizeMemoryContent("a b")).toBe("a b");
    expect(normalizeMemoryContent("a b")).not.toBe(normalizeMemoryContent("ab"));
    expect(normalizeMemoryContent("a\u200bb")).not.toBe(normalizeMemoryContent("a b"));
    expect(key({ content: "a\u200bb" })).not.toBe(key({ content: "a b" }));
  });

  it("não dobra caixa (decisão registrada: 'Margem' ≠ 'margem')", () => {
    expect(normalizeMemoryContent("  Margem  ")).toBe("Margem");
    expect(normalizeMemoryContent("Margem")).not.toBe(normalizeMemoryContent("margem"));
  });
});

describe("memoryDedupDiscriminator — o que separa memórias de mesmo conteúdo", () => {
  it("usa o user_id em scope='user' e vazio em scope='tenant'", () => {
    expect(memoryDedupDiscriminator({ ...BASE_KEY_INPUT, scope: "user" })).toBe("user-1");
    expect(memoryDedupDiscriminator({ ...BASE_KEY_INPUT, scope: "tenant" })).toBe("");
  });

  it("usa a conversa em scope='conversation' e vazio quando não há conversa", () => {
    expect(
      memoryDedupDiscriminator({
        ...BASE_KEY_INPUT,
        scope: "conversation",
        conversationId: "conversation-7",
      }),
    ).toBe("conversation-7");
    expect(
      memoryDedupDiscriminator({ ...BASE_KEY_INPUT, scope: "conversation", conversationId: null }),
    ).toBe("");
  });
});

describe("computeMemoryDedupKey — determinística e sensível a cada campo", () => {
  it("devolve sha256 hex minúsculo do payload documentado", () => {
    const input = { ...BASE_KEY_INPUT, content: "relatórios semanais" };
    expect(key({ content: "relatórios semanais" })).toBe(
      expectedKey("tenant", "", "relatórios semanais"),
    );
    expect(key({ content: "relatórios semanais" })).toMatch(/^[0-9a-f]{64}$/);
    expect(memoryDedupDiscriminator(input)).toBe("");
  });

  it("é estável entre chamadas e entre formas equivalentes do mesmo conteúdo", () => {
    const canonical = key({ content: "relatórios   semanais" });
    expect(key({ content: "relatórios   semanais" })).toBe(canonical);
    expect(key({ content: "\n relatórios\t semanais \n" })).toBe(canonical);
    expect(key({ content: "relatórios semanaís".normalize("NFD") })).toBe(
      key({ content: "relatórios semanaís" }),
    );
  });

  it("separa conteúdos, escopos, usuários e conversas diferentes", () => {
    const tenant = key({ content: "relatórios semanais" });
    // mesmo conteúdo, outro escopo discriminado: duas memórias distintas.
    expect(key({ content: "relatórios semanais", scope: "user" })).not.toBe(tenant);
    expect(
      key({ content: "relatórios semanais", scope: "conversation", conversationId: "c1" }),
    ).not.toBe(
      key({ content: "relatórios semanais", scope: "conversation", conversationId: "c2" }),
    );
    // o mesmo texto de dois usuários não colapsa (racional da SD-C3-1).
    expect(key({ content: "relatórios semanais", scope: "user", userId: "u1" })).not.toBe(
      key({ content: "relatórios semanais", scope: "user", userId: "u2" }),
    );
    // conteúdo diferente e caixa diferente.
    expect(key({ content: "relatórios semanais" })).not.toBe(
      key({ content: "relatórios diários" }),
    );
    expect(key({ content: "Margem" })).not.toBe(key({ content: "margem" }));
  });

  it("não é ambígua na fronteira dos campos (o 0x1f separa scope, discriminador e conteúdo)", () => {
    // Sem separador, ("user", "ab") e ("use", "rab") teriam o mesmo payload; com
    // o 0x1f as chaves são distintas — é a razão do separador existir.
    expect(key({ scope: "user", userId: "ab", content: "c" })).not.toBe(
      key({ scope: "user", userId: "a", content: "bc" }),
    );
    expect(key({ scope: "tenant", content: "a b" })).not.toBe(
      key({ scope: "tenant", content: "ab" }),
    );
  });
});
