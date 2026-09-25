import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function projectFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("fronteiras de persistência FIN-002", () => {
  it("remove defaults legados que convertiam rendimento/imposto ausentes em 1/0", () => {
    const migration = projectFile(
      "docs/archive/supabase/migrations/20260810014633_drop_unknown_financial_defaults.sql",
    );

    expect(migration).toContain("publique primeiro a aplicação");
    expect(migration).toContain("ALTER COLUMN yield_qty DROP DEFAULT");
    expect(migration).toContain("ALTER COLUMN tax_rate DROP DEFAULT");
  });

  it("preserva rendimento/imposto desconhecidos como null no fluxo conversacional", () => {
    const source = projectFile("src/lib/ai/tool-registry.ts");

    expect(source).toContain("yieldQty: null");
    expect(source).toContain("taxRate: null");
    expect(source).toContain("input.tax_rate === undefined ? null");
    expect(source).not.toContain("input.tax_rate ?? 0");
  });

  it("preserva null também quando o produto é criado pelo BFF manual", () => {
    const source = projectFile("src/lib/products.functions.ts");

    expect(source).toContain("data.yield_qty == null ? null");
    expect(source).toContain("data.tax_rate == null ? null");
    expect(source).not.toContain("data.yield_qty ?? 1");
    expect(source).not.toContain("data.tax_rate ?? 0");
  });
});

describe("fronteiras de entrada FIN-003", () => {
  it("usa strings decimais finitas em todos os schemas do BFF financeiro", () => {
    for (const path of ["src/lib/products.functions.ts", "src/lib/expenses.functions.ts"]) {
      const source = projectFile(path);
      expect(source).not.toContain("z.number()");
      expect(source).toMatch(/DecimalStringSchema/);
    }
  });

  it("rejeita texto vazio e números não finitos nos formulários financeiros", () => {
    const expenses = projectFile("src/routes/_authenticated/despesas.tsx");
    const prices = projectFile("src/routes/_authenticated/precos.tsx");

    expect(expenses).toContain('rawAmount === ""');
    expect(expenses).toContain("!Number.isFinite(amount)");
    expect(prices).toContain("!Number.isFinite(valor)");
  });

  it("mantém invalid distinto de incomplete nos consumidores financeiros", () => {
    for (const path of [
      "src/routes/_authenticated/diagnostico.tsx",
      "src/routes/_authenticated/inicio.tsx",
      "src/routes/_authenticated/ponto-equilibrio.tsx",
      "src/routes/_authenticated/simulacoes.tsx",
    ]) {
      const source = projectFile(path);
      expect(source).toContain("role=");
      expect(source).toContain('"alert"');
      expect(source).toContain("Erro de cálculo");
    }

    const simulation = projectFile("src/routes/_authenticated/simulacoes.tsx");
    expect(simulation).toContain('simulated?.status === "invalid"');
    expect(simulation).toContain('role="alert"');
  });

  it("impõe taxas individuais abaixo de 100% no BFF", () => {
    const source = projectFile("src/lib/products.functions.ts");
    expect(source).toContain("tax_rate: percentFractionSchema");
    expect(source).toContain("percentage: percentFractionSchema");
  });
});

describe("fronteiras de proveniência FIN-004", () => {
  it("torna a origem do volume obrigatória no contrato do motor", () => {
    const finance = projectFile("src/lib/finance.ts");

    expect(finance).toContain('export type VolumeSource = "real" | "manual_simulation"');
    expect(finance).toContain("volumeSource: VolumeSource");
    expect(finance).toContain('return source === "real"');
    expect(finance).toContain("Volume numérico não pode ter origem desconhecida");
  });

  it("remove o cenário atual fictício e inicia o volume manual vazio", () => {
    const simulation = projectFile("src/routes/_authenticated/simulacoes.tsx");

    expect(simulation).not.toMatch(/const\s+volume\s*=\s*100/);
    expect(simulation).not.toContain("Cenário atual");
    expect(simulation).not.toContain("Diferença vs. atual");
    expect(simulation).toContain('volume: ""');
    expect(simulation).toContain('volumeSource: "manual_simulation"');
    expect(simulation).toContain("Faturamento simulado");
    expect(simulation).toContain("Resultado operacional simulado dentro do escopo informado");
    expect(simulation).toContain("aria-describedby");
  });

  it("não apresenta soma de preços ou média simples como KPI consolidado", () => {
    const dashboard = projectFile("src/routes/_authenticated/inicio.tsx");

    expect(dashboard).not.toContain("totalRevenue");
    expect(dashboard).not.toContain("sumCmPct");
    expect(dashboard).not.toContain("avgCmPct");
    expect(dashboard).not.toContain("calculateBreakEvenRevenue");
    expect(dashboard).toContain('label="Faturamento real"');
    expect(dashboard).toContain('description="Nenhuma venda real registrada."');
  });

  it("distingue falha de consulta de uma coleção financeira vazia", () => {
    for (const path of [
      "src/routes/_authenticated/inicio.tsx",
      "src/routes/_authenticated/simulacoes.tsx",
    ]) {
      const source = projectFile(path);
      expect(source).toContain("isError");
      if (path === "src/routes/_authenticated/inicio.tsx") {
        expect(source).toContain("summaryQuery.isError");
      } else {
        expect(source).toContain("productsQuery.isError || expensesQuery.isError");
      }
      expect(source).toContain("Referência de atendimento");
      expect(source).toContain("Tentar novamente");
      if (path === "src/routes/_authenticated/simulacoes.tsx") {
        expect(source).toMatch(/loadStatus === "error"\s*\|\|\s*!selectedDetail/);
        expect(source).toContain(
          "<ProductState status={productStatus} errorReference={errorReference} />",
        );
        expect(source).toContain("simulationQuery.isError");
        expect(source).toContain('message="Não foi possível calcular a simulação."');
      }
    }
  });
});

describe("fronteiras de formação de preço FIN-005", () => {
  it("remove multiplicador arbitrário e linguagem de preço sugerido", () => {
    const diagnostic = projectFile("src/routes/_authenticated/diagnostico.tsx");
    const landing = projectFile("src/routes/index.tsx");
    const chat = projectFile("src/lib/chat.functions.ts");

    for (const source of [diagnostic, landing, chat]) {
      expect(source).not.toMatch(/\*\s*1\.5|1\.5\s*\*/);
      expect(source).not.toMatch(/preço (certo|correto|sugerido)/i);
    }
    expect(diagnostic).not.toContain("suggestedPrice");
  });

  it("exige premissas explícitas sem transformar vazio em zero", () => {
    const diagnostic = projectFile("src/routes/_authenticated/diagnostico.tsx");

    expect(diagnostic).toContain('nonPercentageVariableUnitCost: ""');
    expect(diagnostic).toContain('targetContributionRate: ""');
    expect(diagnostic).toContain("parseOptionalNumber");
    expect(diagnostic).toContain('return normalized === "" ? null');
    expect(diagnostic).toContain("Nenhuma margem padrão é presumida");
  });

  it("distingue cálculo interno, simulação e referência de mercado", () => {
    const diagnostic = projectFile("src/routes/_authenticated/diagnostico.tsx");

    expect(diagnostic).toContain('label="Preço mínimo para custos unitários"');
    expect(diagnostic).toContain('label="Preço para margem-alvo"');
    expect(diagnostic).toContain('label="Preço médio de mercado informado"');
    expect(diagnostic).toContain('description="Simulação não salva"');
    expect(diagnostic).toContain("Referência externa sem fonte estruturada");
  });

  it("não rateia despesas periódicas sem volume ou direcionador", () => {
    const diagnostic = projectFile("src/routes/_authenticated/diagnostico.tsx");

    expect(diagnostic).toContain("hasUnallocatedVariableExpenses");
    expect(diagnostic).toContain("falta um volume ou direcionador confiável");
    expect(diagnostic).not.toMatch(/variableExpenses\s*\/|expense\.amount\s*\//);
  });

  it("calcula custo direto sem depender do preço atual e verifica erros remotos", () => {
    const finance = projectFile("src/lib/finance.ts");
    const diagnostic = projectFile("src/routes/_authenticated/diagnostico.tsx");
    const diagnosticService = projectFile("src/server/services/diagnostic.service.ts");

    expect(finance).toContain("export function computeProductCost");
    expect(finance).toContain("export function calculatePriceFormation");
    expect(diagnostic).toContain("productsListQueryOptions()");
    expect(diagnostic).toContain("isError");
    expect(diagnostic).toContain("productsQuery.isError || expensesQuery.isError");
    expect(diagnosticService).toContain("Number.isFinite(difference)");
    expect(diagnostic).not.toMatch(/current_price\s*[),]\s*ingredients/);
  });
});
