import { describe, expect, it } from "vitest";

import { calculateBreakEvenRevenue } from "@/lib/finance";
import { brl, decimalInput, num, numericDisplayState, pct, qty } from "@/lib/format";

const formatters = [brl, pct, num] as const;

const brlParse = (s: string) => Number(s.replace(",", "."));

describe("formatação de estados numéricos FIN-003", () => {
  it.each([null, undefined])("renderiza %s como dado incompleto", (value) => {
    for (const format of formatters) expect(format(value)).toBe("—");
    expect(numericDisplayState(value)).toBe("incomplete");
  });

  it("renderiza NaN como erro de cálculo", () => {
    for (const format of formatters) expect(format(Number.NaN)).toBe("Erro de cálculo");
    expect(numericDisplayState(Number.NaN)).toBe("invalid");
  });

  it("renderiza Infinity semântico como não atingível", () => {
    for (const format of formatters) expect(format(Number.POSITIVE_INFINITY)).toBe("Não atingível");
    // O motor não transporta Infinity: reachability é expressa pelo BreakEvenResult.
    expect(brl(calculateBreakEvenRevenue(6000, 0))).toBe("—");
    expect(numericDisplayState(Number.POSITIVE_INFINITY)).toBe("infinite");
  });

  it("renderiza -Infinity como erro de cálculo", () => {
    for (const format of formatters)
      expect(format(Number.NEGATIVE_INFINITY)).toBe("Erro de cálculo");
    expect(numericDisplayState(Number.NEGATIVE_INFINITY)).toBe("invalid");
  });

  it("preserva zero conhecido e números finitos", () => {
    expect(brl(0)).toContain("0,00");
    expect(pct(0)).toBe("0,00%");
    expect(num(0)).toBe("0,00");
    expect(numericDisplayState(0)).toBe("ok");
  });
});

describe("decimalInput: seed de input decimal pt-BR", () => {
  it.each([
    ["20.0000", "20,00", 20],
    ["1234.5", "1234,50", 1234.5],
    [0, "0,00", 0],
  ])("converte %p para %p com round-trip sem perda", (value, expected, parsed) => {
    expect(decimalInput(value)).toBe(expected);
    expect(brlParse(decimalInput(value))).toBe(parsed);
  });

  it.each([null, undefined])("renderiza %p como vazio", (value) => {
    expect(decimalInput(value)).toBe("");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "abc", ""])("renderiza %p como vazio", (value) => {
    expect(decimalInput(value)).toBe("");
  });

  it("preserva dígitos além do mínimo sem artefato de float", () => {
    expect(decimalInput("0.005")).toBe("0,005");
    expect(brlParse(decimalInput("0.005"))).toBe(0.005);
    expect(decimalInput("19.9999")).toBe("19,9999");
  });

  it("rejeita escala acima do contrato em vez de arredondar silenciosamente", () => {
    expect(decimalInput("1.2345678")).toBe("");
    expect(decimalInput("1.23", 7)).toBe("");
  });

  it("é idempotente após o parse de submissão", () => {
    for (const value of ["20.0000", "1234.5", 0]) {
      const once = decimalInput(value);
      const twice = decimalInput(brlParse(once));
      expect(brlParse(twice)).toBe(brlParse(once));
    }
  });
});

describe("qty: quantidade com unidade", () => {
  it("formata com vírgula e sem zeros à direita", () => {
    expect(qty("0.5", "kg")).toBe("0,5 kg");
    expect(qty("6.5", "unidade(s)")).toBe("6,5 unidade(s)");
    expect(qty("6.000000", "kg")).toBe("6 kg");
    expect(qty("0.005", "kg")).toBe("0,005 kg");
    expect(qty("9007199254740993", "unidade")).toBe("9007199254740993 unidade");
    expect(qty(2, "kg")).toBe("2 kg");
    expect(qty("3")).toBe("3");
  });

  it.each([null, undefined])("renderiza %p como dado incompleto", (value) => {
    expect(qty(value)).toBe("—");
  });

  it("renderiza NaN como erro de cálculo e Infinity como não atingível", () => {
    expect(qty(Number.NaN)).toBe("Erro de cálculo");
    expect(qty(Number.POSITIVE_INFINITY)).toBe("Não atingível");
  });
});
