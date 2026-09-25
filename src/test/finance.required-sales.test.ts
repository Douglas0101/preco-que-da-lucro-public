import { describe, expect, it } from "vitest";
import {
  calculateBreakEvenRevenue,
  calculateBreakEvenUnits,
  calculateRequiredSalesForProfit,
  sumFiniteNumbers,
} from "@/lib/finance";

describe("segurança dos cálculos de vendas necessárias", () => {
  it.each([
    ["despesas fixas negativas", -1],
    ["despesas fixas NaN", Number.NaN],
    ["despesas fixas infinitas", Number.POSITIVE_INFINITY],
  ])("rejeita %s", (_label, fixedExpenses) => {
    expect(calculateRequiredSalesForProfit(fixedExpenses, 0, 10)).toMatchObject({
      status: "invalid",
      errors: [{ field: "fixedExpenses", code: "INVALID_NUMBER" }],
    });
  });

  it.each([
    ["lucro desejado negativo", -1],
    ["lucro desejado NaN", Number.NaN],
    ["lucro desejado infinito", Number.POSITIVE_INFINITY],
  ])("rejeita %s", (_label, desiredProfit) => {
    expect(calculateRequiredSalesForProfit(0, desiredProfit, 10)).toMatchObject({
      status: "invalid",
      errors: [{ field: "desiredProfit", code: "INVALID_NUMBER" }],
    });
  });

  it("preserva zero como entrada válida", () => {
    expect(calculateRequiredSalesForProfit(0, 0, 10)).toMatchObject({
      status: "reachable",
      rawUnits: 0,
      roundedUnits: 0,
    });
  });

  it("mantém contribuição negativa como cenário válido porém inalcançável", () => {
    expect(calculateRequiredSalesForProfit(100, 20, -1)).toMatchObject({
      status: "unreachable",
      reason: "NON_POSITIVE_CONTRIBUTION",
    });
  });

  it("rejeita margem de contribuição não finita", () => {
    expect(calculateRequiredSalesForProfit(100, 20, Number.NaN)).toMatchObject({
      status: "invalid",
      errors: [{ field: "cmUnit", code: "INVALID_NUMBER" }],
    });
  });

  it("rejeita despesas fixas negativas também no break-even direto", () => {
    expect(calculateBreakEvenUnits(-1, 10)).toMatchObject({
      status: "invalid",
      errors: [{ field: "fixedExpenses", code: "INVALID_NUMBER" }],
    });
  });

  it("não transforma receita com despesa inválida em zero", () => {
    expect(calculateBreakEvenRevenue(-1, 10)).toBeNaN();
  });

  it("propaga overflow de soma como valor não finito", () => {
    expect(sumFiniteNumbers([Number.MAX_VALUE, Number.MAX_VALUE])).toBeNaN();
  });

  it("calcula lucro-alvo com valores finitos", () => {
    expect(calculateRequiredSalesForProfit(100, 50, 10)).toMatchObject({
      status: "reachable",
      rawUnits: 15,
      roundedUnits: 15,
    });
  });
});
