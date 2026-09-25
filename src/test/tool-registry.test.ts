import { describe, expect, it } from "vitest";
import {
  GATEWAY_TOOLS,
  GLOBAL_TOOL_NAMES,
  PRODUCT_SCOPED_TOOL_NAMES,
  TOOL_REGISTRY,
  gatewayToolsForState,
  toolExecutionOutputSchema,
} from "@/lib/ai/tool-registry";
import { sanitizeAiOutput } from "@/lib/ai/output-sanitizer";
import { contextWithRole } from "./helpers/request-context";

describe("registro tipado das tools de IA", () => {
  it("publica exatamente as dez tools com JSON Schema", () => {
    expect(TOOL_REGISTRY.size).toBe(10);
    expect(GATEWAY_TOOLS).toHaveLength(10);
    expect(GATEWAY_TOOLS.every((tool) => tool.function.parameters.type === "object")).toBe(true);
  });

  it("rejeita entrada inválida antes de construir o executor", () => {
    const definition = TOOL_REGISTRY.get("set_yield");
    const prepared = definition?.prepare(contextWithRole("owner"), {
      product_id: "não-é-uuid",
      yield_qty: Number.POSITIVE_INFINITY,
      yield_unit: "un",
    });
    expect(prepared).toEqual({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("rejeita mutação sem role antes de tocar o banco", () => {
    const definition = TOOL_REGISTRY.get("create_product");
    const prepared = definition?.prepare(contextWithRole("viewer"), { name: "Bolo" });
    expect(prepared).toEqual({ ok: false, code: "AUTHORIZATION_ERROR" });
  });

  it("preserva ausência de imposto como null no executor validado", () => {
    const definition = TOOL_REGISTRY.get("set_price_and_tax");
    const prepared = definition?.prepare(contextWithRole("owner"), {
      product_id: "50000000-0000-4000-8000-000000000005",
      current_price: "10.0000",
      tax_regime: "Não sei",
    });
    expect(prepared?.ok).toBe(true);
  });

  it("transporta percentuais como frações decimais em string", () => {
    const definition = TOOL_REGISTRY.get("add_fee");
    const base = {
      product_id: "50000000-0000-4000-8000-000000000005",
      name: "Cartão",
    };
    expect(definition?.prepare(contextWithRole("owner"), { ...base, percentage: "0.035" }).ok).toBe(
      true,
    );
    expect(definition?.prepare(contextWithRole("owner"), { ...base, percentage: 3.5 })).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
    });
  });

  it("valida a saída pública da tool e remove HTML do texto da IA", () => {
    expect(
      toolExecutionOutputSchema.safeParse({ result: { value: "ok" }, state: {} }).success,
    ).toBe(true);
    expect(toolExecutionOutputSchema.safeParse({ result: "não é objeto" }).success).toBe(false);
    expect(sanitizeAiOutput("<script>alert(1)</script> Olá\u0000 **mundo**")).toBe(
      "alert(1) Olá **mundo**",
    );
  });
});

describe("allowlist de tools por estado conversacional (plano §14.2)", () => {
  it("sem produto confirmado expõe apenas as tools globais", () => {
    const names = gatewayToolsForState(null).map((tool) => tool.function.name);
    expect(names.sort()).toEqual([...GLOBAL_TOOL_NAMES].sort());
  });

  it("com produto confirmado expõe o catálogo completo", () => {
    const names = gatewayToolsForState("50000000-0000-4000-8000-000000000005").map(
      (tool) => tool.function.name,
    );
    expect(names).toHaveLength(GATEWAY_TOOLS.length);
  });

  it("classifica todas as tools registradas sem órfãos", () => {
    for (const name of TOOL_REGISTRY.keys()) {
      expect(
        GLOBAL_TOOL_NAMES.has(name) || PRODUCT_SCOPED_TOOL_NAMES.has(name),
        `tool não classificada: ${name}`,
      ).toBe(true);
    }
    expect(GLOBAL_TOOL_NAMES.size + PRODUCT_SCOPED_TOOL_NAMES.size).toBe(TOOL_REGISTRY.size);
  });

  it("tools com escopo de produto exigem currentProductId para aparecer", () => {
    const globalOnly = new Set(gatewayToolsForState(null).map((tool) => tool.function.name));
    for (const name of PRODUCT_SCOPED_TOOL_NAMES) {
      expect(globalOnly.has(name), `${name} vazou sem produto confirmado`).toBe(false);
    }
  });
});
