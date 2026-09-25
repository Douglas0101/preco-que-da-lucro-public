import type { ReactNode } from "react";

/**
 * Renderização mínima e segura de markdown do chat (SEC-001, lote 02).
 *
 * Suporta apenas `**negrito**` e quebras de linha. O conteúdo vem do gateway
 * de IA (terceiro não confiável — V7 correção #14): tudo vira text node ou
 * <strong>, que o React escapa por construção. Nenhum HTML é avaliado, em
 * nenhuma hipótese — não existe caminho de `dangerouslySetInnerHTML`.
 */
export function renderChatMarkdown(text: string): ReactNode[] {
  const lineOccurrences = new Map<string, number>();
  return text.split("\n").map((line) => {
    const occurrence = lineOccurrences.get(line) ?? 0;
    lineOccurrences.set(line, occurrence + 1);
    return <div key={`${line}-${occurrence}`}>{renderLine(line)}</div>;
  });
}

function renderLine(line: string): ReactNode[] {
  const partOccurrences = new Map<string, number>();
  return line.split(/(\*\*.+?\*\*)/g).map((part) => {
    const occurrence = partOccurrences.get(part) ?? 0;
    partOccurrences.set(part, occurrence + 1);
    const key = `${part}-${occurrence}`;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <span key={key}>{part}</span>;
  });
}
