import Decimal from "decimal.js";
import { logJson } from "@/lib/structured-logger";
import {
  calculateBreakEvenUnits,
  computeProductCost,
  type BreakEvenResult,
  type CalculationResult,
  type FeeRow,
  type ProductComputation,
  type ProductCostComputation,
} from "@/lib/finance";
import { applicationMetrics } from "@/instrumentation/telemetry";
import type { RequestContext } from "@/lib/request-context";
import { expenseService } from "@/server/services/expense.service";
import {
  calculationSnapshotService,
  deriveSnapshotIdempotencyKey,
} from "@/server/services/calculation-snapshot.service";
import { FINANCE_ENGINE_VERSION } from "@/server/services/financial.service";
import { pricingService } from "@/server/services/pricing.service";
import { loadProductFinancialDetail } from "@/server/services/product-detail.service";

export interface DiagnosticInput {
  productId: string;
  nonPercentageVariableUnitCost: number | null;
  targetContributionRate: number | null;
}

export interface DiagnosticAlert {
  level: "warn" | "info" | "danger";
  text: string;
}

export type DiagnosticStatus = "ok" | "incomplete" | "invalid";

export interface CurrentAnalysis {
  computation: ProductComputation;
  price: number;
  breakEvenUnits: BreakEvenResult;
  alerts: DiagnosticAlert[];
}

export interface DiagnosticView {
  productId: string;
  productName: string;
  fixedExpenses: number;
  cost: CalculationResult<ProductCostComputation>;
  currentStatus: DiagnosticStatus;
  currentAnalysis: CurrentAnalysis | null;
  currentPrice: number | null;
  taxRate: number | null;
  fees: FeeRow[];
  market: { avgPrice: number | null } | null;
  priceFormation: {
    minimumSustainablePrice: CalculationResult<number>;
    targetMarginPrice: CalculationResult<number>;
    marketReference: CalculationResult<number>;
  };
  engineVersion: string;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return value == null ? null : Number(value);
}

function marketAlert(price: number, marketAvgPrice: string | null): DiagnosticAlert | null {
  const marketAverage = nullableNumber(marketAvgPrice);
  if (
    marketAverage == null ||
    !Number.isFinite(marketAverage) ||
    marketAverage <= 0 ||
    price <= 0
  ) {
    return null;
  }
  const difference = ((price - marketAverage) / marketAverage) * 100;
  if (!Number.isFinite(difference) || Math.abs(difference) <= 20) return null;
  return {
    level: "info",
    text: `Seu preço atual está ${difference > 0 ? "acima" : "abaixo"} da referência de mercado informada em ${Math.abs(difference).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%. Mercado é contexto; posicionamento, qualidade e capacidade também importam.`,
  };
}

function buildCurrentAlerts(
  metrics: ProductComputation,
  fixedExpenses: number,
  price: number,
  breakEvenUnits: BreakEvenResult,
  marketAvgPrice: string | null,
): DiagnosticAlert[] {
  const alerts: DiagnosticAlert[] = [];
  if (price < metrics.unitCost) {
    alerts.push({
      level: "danger",
      text: "Seu preço de venda está abaixo do custo unitário. Cada venda gera prejuízo — vale investigar.",
    });
  }
  if (metrics.contributionMarginPct > 0 && metrics.contributionMarginPct < 20) {
    alerts.push({
      level: "warn",
      text: `Margem de contribuição baixa (${metrics.contributionMarginPct.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%). Pode representar risco no médio prazo.`,
    });
  }
  if (fixedExpenses > 0 && breakEvenUnits.status === "unreachable") {
    alerts.push({
      level: "warn",
      text: "Com a margem atual, você não cobre as despesas fixas. Pode ser interessante simular preço maior ou custo menor.",
    });
  }
  const referenceAlert = marketAlert(price, marketAvgPrice);
  if (referenceAlert) alerts.push(referenceAlert);
  return alerts;
}

function analyzeCurrentProduct(
  metrics: CalculationResult<ProductComputation>,
  fixedExpenses: number,
  currentPrice: number | null,
  marketAvgPrice: string | null,
): { status: DiagnosticStatus; analysis: CurrentAnalysis | null } {
  if (metrics.status !== "ok") return { status: metrics.status, analysis: null };
  const price = currentPrice as number;
  const breakEvenUnits = calculateBreakEvenUnits(fixedExpenses, metrics.value.contributionMargin);
  if (breakEvenUnits.status === "invalid") return { status: "invalid", analysis: null };
  return {
    status: "ok",
    analysis: {
      computation: metrics.value,
      price,
      breakEvenUnits,
      alerts: buildCurrentAlerts(
        metrics.value,
        fixedExpenses,
        price,
        breakEvenUnits,
        marketAvgPrice,
      ),
    },
  };
}

function fixedExpensesTotal(context: RequestContext): Promise<number> {
  return expenseService.list(context).then((rows) => {
    let total = new Decimal(0);
    let invalid = false;
    for (const expense of rows) {
      if (expense.type !== "fixa") continue;
      try {
        const amount = new Decimal(expense.amount);
        if (!amount.isFinite() || amount.isNegative()) {
          invalid = true;
          continue;
        }
        total = total.plus(amount);
      } catch {
        invalid = true;
      }
    }
    if (invalid || !total.isFinite()) return Number.NaN;
    return total.toNumber();
  });
}

/**
 * Server-side diagnostic: loads tenant data, projects the financial read
 * model, runs the price formation engine and records audit snapshots. The
 * browser only collects assumptions and renders the typed result (INV-004).
 */
export async function getDiagnostic(
  context: RequestContext,
  input: DiagnosticInput,
): Promise<DiagnosticView> {
  const detail = await loadProductFinancialDetail(context, input.productId);
  if (!detail) throw new Error("NOT_FOUND");

  const fixedExpenses = await fixedExpensesTotal(context);
  const depth = detail.product.yieldQty == null ? null : Number(detail.product.yieldQty);
  const currentPrice =
    detail.product.currentPrice == null ? null : Number(detail.product.currentPrice);
  const taxRate = detail.product.taxRate == null ? null : Number(detail.product.taxRate) * 100;
  const cost = computeProductCost({
    ingredients: detail.ingredients,
    packaging: detail.packaging,
    yieldQty: depth,
  });
  const currentResult = analyzeCurrentProduct(
    detail.metrics,
    fixedExpenses,
    currentPrice,
    detail.market?.avgPrice ?? null,
  );
  const priceFormation = pricingService.calculatePriceFormationFor({
    directUnitCost:
      cost.status === "ok" ? cost.value.unitCost : cost.status === "invalid" ? Number.NaN : null,
    nonPercentageVariableUnitCost: input.nonPercentageVariableUnitCost,
    taxRate,
    fees: detail.fees,
    targetContributionRate: input.targetContributionRate,
    marketReference: nullableNumber(detail.market?.avgPrice),
  });

  const view: DiagnosticView = {
    productId: detail.product.id,
    productName: detail.product.name,
    fixedExpenses,
    cost,
    currentStatus: currentResult.status,
    currentAnalysis: currentResult.analysis,
    currentPrice,
    taxRate,
    fees: detail.fees,
    market: detail.market ? { avgPrice: nullableNumber(detail.market.avgPrice) } : null,
    priceFormation,
    engineVersion: FINANCE_ENGINE_VERSION,
  };

  applicationMetrics.diagnosticCalculationTotal.add(1, { status: currentResult.status });
  await recordDiagnosticSnapshots(context, input, view);
  return view;
}

async function recordDiagnosticSnapshots(
  context: RequestContext,
  input: DiagnosticInput,
  view: DiagnosticView,
): Promise<void> {
  const inputs: Record<string, unknown> = {
    productId: input.productId,
    nonPercentageVariableUnitCost: input.nonPercentageVariableUnitCost,
    targetContributionRate: input.targetContributionRate,
    marketAvgPrice: view.market?.avgPrice ?? null,
  };
  // SAFETY: `JSON.parse(JSON.stringify(...))` cannot throw here. `view` is a fresh
  // object literal assembled in `getDiagnostic` whose leaves are primitives, flat
  // records of primitives and arrays of those (financial-engine results, `fees`
  // rows, a nullable market record) - none of them can reference `view` itself, so
  // `JSON.stringify` cannot encounter a cycle, and the string it produces is by
  // construction valid JSON for `JSON.parse`. The deep clone exists to drop
  // `undefined` leaves before the snapshot payload is hashed. If a non-JSON-safe
  // value (e.g. a circular reference or a BigInt) is ever added to `view`, this
  // assumption breaks and the call must be wrapped in try/catch.
  const outputs: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      cost: view.cost,
      currentStatus: view.currentStatus,
      currentAnalysis: view.currentAnalysis,
      currentPrice: view.currentPrice,
      taxRate: view.taxRate,
      fees: view.fees,
      priceFormation: view.priceFormation,
      fixedExpenses: view.fixedExpenses,
    }),
  ) as Record<string, unknown>;
  // Chave deterministica derivada do helper unico (WS-03 / §22): replay da
  // mesma analise converge no mesmo registro (UNIQUE) — nunca duplica, e a
  // entidade (productId) faz parte da chave.
  try {
    await calculationSnapshotService.append(context, {
      entityType: "product",
      entityId: input.productId,
      calculationType: "diagnostic",
      idempotencyKey: deriveSnapshotIdempotencyKey({
        calculationType: "diagnostic",
        entityType: "product",
        entityId: input.productId,
        engineVersion: FINANCE_ENGINE_VERSION,
        inputs,
      }),
      inputs,
      outputs,
      engineVersion: FINANCE_ENGINE_VERSION,
    });
    applicationMetrics.snapshotCreatedTotal.add(1, { type: "diagnostic" });
    await pricingService.appendPricingSnapshot(context, {
      productId: input.productId,
      nonPercentageVariableUnitCost: input.nonPercentageVariableUnitCost,
      targetContributionRate: input.targetContributionRate,
      marketAvgPrice: view.market?.avgPrice ?? null,
      priceFormation: view.priceFormation,
    });
  } catch (error) {
    applicationMetrics.snapshotFailureTotal.add(1, { type: "diagnostic" });
    logJson("warn", "diagnostic.snapshot_failed", {
      productId: input.productId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}
