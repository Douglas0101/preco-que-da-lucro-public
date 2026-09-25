import { describe, expect, it } from "vitest";
import { LIST_LIMITS } from "@/lib/list-limits";

describe("LIST_LIMITS (plano mestre §16.6)", () => {
  it("define limites positivos e inteiros para todas as listagens", () => {
    for (const [key, value] of Object.entries(LIST_LIMITS)) {
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it("limites são redes de segurança, não paginação de UX", () => {
    expect(LIST_LIMITS.products).toBeGreaterThanOrEqual(100);
    expect(LIST_LIMITS.productChildren).toBeGreaterThanOrEqual(500);
    expect(LIST_LIMITS.expenses).toBeGreaterThanOrEqual(200);
    expect(LIST_LIMITS.simulations).toBeGreaterThanOrEqual(50);
  });

  it("limites permanecem abaixo do teto de recurso por request", () => {
    for (const [key, value] of Object.entries(LIST_LIMITS)) {
      expect(value, key).toBeLessThanOrEqual(10_000);
    }
  });
});
