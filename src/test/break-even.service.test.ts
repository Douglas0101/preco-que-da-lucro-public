import { describe, expect, it } from "vitest";
import { calculateBreakEvenSummary } from "@/server/services/break-even.service";

describe("break-even service", () => {
  it("mantém valores decimais como strings e arredonda unidades indivisíveis para cima", () => {
    const result = calculateBreakEvenSummary({
      fixedExpenses: ["101"],
      price: "20",
      contributionMargin: "10",
      contributionMarginPct: "50",
      desiredProfit: null,
      unitMode: "discrete",
    });

    expect(result.status).toBe("reachable");
    expect(result.fixedExpenses).toBe("101.0000");
    expect(result.units).toMatchObject({
      status: "reachable",
      rawUnits: "10.100000",
      roundedUnits: "11.000000",
    });
    expect(result.revenue).toBe("202.0000");
    expect(
      typeof result.units === "object" && result.units.status === "reachable"
        ? typeof result.units.rawUnits
        : "unknown",
    ).toBe("string");
  });

  it("não fabrica volume quando a margem é não positiva", () => {
    const result = calculateBreakEvenSummary({
      fixedExpenses: ["100"],
      price: "10",
      contributionMargin: "0",
      contributionMarginPct: "0",
      desiredProfit: null,
      unitMode: "discrete",
    });

    expect(result.units).toMatchObject({
      status: "unreachable",
      rawUnits: null,
      roundedUnits: null,
    });
    expect(result.revenue).toBeNull();
  });
});
