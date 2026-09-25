import { describe, expect, it } from "vitest";
import { WEB_VITALS_MAX_PAYLOAD_BYTES, safeParseVitalMetric } from "@/lib/web-vitals-payload";

const validMetric = {
  id: "v6-1724000000000-123456789012",
  name: "LCP",
  value: 2412.5,
  rating: "good",
  delta: 2412.5,
  navigationType: "navigate",
};

describe("validação de payload RUM (plano mestre §17.8)", () => {
  it("aceita métrica válida e preserva os campos conhecidos", () => {
    const parsed = safeParseVitalMetric(validMetric);

    expect(parsed).toEqual(validMetric);
  });

  it("aceita payload sem navigationType e sem entries", () => {
    const { navigationType: _navigationType, ...minimal } = validMetric;

    expect(safeParseVitalMetric(minimal)).toEqual(minimal);
  });

  it("rejeita nome de métrica desconhecido", () => {
    expect(safeParseVitalMetric({ ...validMetric, name: "XYZ" })).toBeNull();
  });

  it("rejeita rating fora da escala do web-vitals", () => {
    expect(safeParseVitalMetric({ ...validMetric, rating: "excellent" })).toBeNull();
  });

  it("rejeita valores negativos e não finitos", () => {
    expect(safeParseVitalMetric({ ...validMetric, value: -1 })).toBeNull();
    expect(safeParseVitalMetric({ ...validMetric, delta: Number.NaN })).toBeNull();
    expect(safeParseVitalMetric({ ...validMetric, value: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("rejeita ids ausentes ou excessivamente longos", () => {
    const longId = "a".repeat(65);

    expect(safeParseVitalMetric({ ...validMetric, id: "" })).toBeNull();
    expect(safeParseVitalMetric({ ...validMetric, id: longId })).toBeNull();
  });

  it("rejeita navigationType e entries fora dos limites", () => {
    expect(safeParseVitalMetric({ ...validMetric, navigationType: "teleport" })).toBeNull();
    expect(
      safeParseVitalMetric({ ...validMetric, entries: Array.from({ length: 11 }, () => ({})) }),
    ).toBeNull();
  });

  it("rejeita payloads não-objeto", () => {
    expect(safeParseVitalMetric(null)).toBeNull();
    expect(safeParseVitalMetric("LCP")).toBeNull();
    expect(safeParseVitalMetric([validMetric])).toBeNull();
  });

  it("mantém o teto duro de payload dentro de 2KB", () => {
    expect(WEB_VITALS_MAX_PAYLOAD_BYTES).toBe(2_048);
    expect(JSON.stringify(validMetric).length).toBeLessThan(WEB_VITALS_MAX_PAYLOAD_BYTES);
  });
});
