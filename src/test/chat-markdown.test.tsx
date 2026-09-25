import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderChatMarkdown } from "@/lib/chat-markdown";

/**
 * Testes de regressão XSS do renderer do chat (SEC-001, lote 02 — Plano §6.1).
 *
 * O conteúdo renderizado vem do gateway de IA (terceiro não confiável).
 * DoD: nenhuma execução, nenhum elemento perigoso criado, payload inerte
 * como texto, e nenhum atributo de event handler no DOM resultante.
 */

const XSS_PAYLOADS: Array<{ name: string; payload: string }> = [
  { name: "script", payload: "<script>alert(1)</script>" },
  { name: "img onerror", payload: "<img src=x onerror=alert(1)>" },
  { name: "javascript: URL", payload: '<a href="javascript:alert(1)">clique</a>' },
  { name: "svg onload", payload: "<svg onload=alert(1)></svg>" },
  { name: "iframe", payload: "<iframe src=https://evil.example></iframe>" },
  { name: "event handler attribute", payload: "<div onmouseover=alert(1)>texto</div>" },
];

function renderContent(content: string) {
  return render(<div data-testid="msg">{renderChatMarkdown(content)}</div>);
}

describe("renderChatMarkdown — regressão XSS", () => {
  it.each(XSS_PAYLOADS)("não cria elementos perigosos para payload: $name", ({ payload }) => {
    const { container } = renderContent(payload);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it.each(XSS_PAYLOADS)("payload aparece como texto inerte: $name", ({ payload }) => {
    const { container } = renderContent(payload);
    expect(container.textContent).toContain(payload);
  });

  it.each(XSS_PAYLOADS)("nenhum atributo de event handler no DOM: $name", ({ payload }) => {
    const { container } = renderContent(payload);
    for (const el of container.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.toLowerCase()).not.toMatch(/^on/);
      }
    }
  });

  it("não usa dangerouslySetInnerHTML (renderer produz apenas nós React)", () => {
    // Canário: serializar elementos React depende da forma interna do objeto
    // (não é API estável). A prova real são os testes DOM-based acima; este
    // existe só para apitar se um dia alguém reintroduzir a prop.
    const nodes = renderChatMarkdown("<b>negrito real?</b> **sim**");
    // Se algum nó carregasse __html perigoso, viria como objeto com
    // dangerouslySetInnerHTML; aqui só existem elementos React planos.
    const serialized = JSON.stringify(nodes, (_key, value) =>
      typeof value === "object" && value !== null && "dangerouslySetInnerHTML" in value
        ? "FORBIDDEN"
        : value,
    );
    expect(serialized).not.toContain("FORBIDDEN");
  });
});

describe("renderChatMarkdown — preservação de formato", () => {
  it("**negrito** vira <strong>", () => {
    renderContent("Olá! **Qual produto** você quer analisar?");
    const strong = screen.getByText("Qual produto");
    expect(strong.tagName).toBe("STRONG");
  });

  it("múltiplas linhas viram blocos separados", () => {
    const { container } = renderContent("linha um\nlinha dois\nlinha três");
    const blocks = container.querySelectorAll('[data-testid="msg"] > div');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].textContent).toBe("linha um");
    expect(blocks[2].textContent).toBe("linha três");
  });

  it("texto simples permanece intacto", () => {
    const { container } = renderContent("mensagem sem formatação");
    expect(container.textContent).toBe("mensagem sem formatação");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("abridor `**` sem fechador não vira negrito", () => {
    const { container } = renderContent("texto **incompleto");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("texto **incompleto");
  });

  it("par completo `**...**` sempre vira negrito (paridade com o renderer original)", () => {
    const { container } = renderContent("2 ** 3 = 6 e ** fim");
    // Paridade: o renderer anterior (`\*\*(.+?)\*\*` + innerHTML) também
    // transformava esse par em <strong>. Não é regressão do lote 02.
    expect(container.querySelector("strong")?.textContent).toBe(" 3 = 6 e ");
  });
});
