import {
  calculatePriceFormation,
  type PriceFormationInput,
  type PriceFormationResult,
} from "@/lib/finance";
import { logJson } from "@/lib/structured-logger";
import type { RequestContext } from "@/lib/request-context";
import { applicationMetrics } from "@/instrumentation/telemetry";
import {
  calculationSnapshotService,
  deriveSnapshotIdempotencyKey,
  type CalculationSnapshotService,
} from "@/server/services/calculation-snapshot.service";
import { FINANCE_ENGINE_VERSION } from "@/server/services/financial.service";

export interface PricingSnapshotInput {
  productId: string;
  nonPercentageVariableUnitCost: number | null;
  targetContributionRate: number | null;
  marketAvgPrice: number | null;
  priceFormation: PriceFormationResult;
}

export interface PricingService {
  calculatePriceFormationFor(input: PriceFormationInput): PriceFormationResult;
  appendPricingSnapshot(context: RequestContext, input: PricingSnapshotInput): Promise<void>;
}

export class DefaultPricingService implements PricingService {
  constructor(
    private readonly snapshots: CalculationSnapshotService = calculationSnapshotService,
  ) {}

  calculatePriceFormationFor(input: PriceFormationInput): PriceFormationResult {
    return calculatePriceFormation(input);
  }

  /**
   * Persists the pricing half of the diagnostic audit trail (`pricing`
   * snapshot). Failures are recorded as metrics/logs and never bubble: the
   * diagnostic view is the response contract and stays unchanged.
   */
  async appendPricingSnapshot(context: RequestContext, input: PricingSnapshotInput): Promise<void> {
    const inputs: Record<string, unknown> = {
      productId: input.productId,
      nonPercentageVariableUnitCost: input.nonPercentageVariableUnitCost,
      targetContributionRate: input.targetContributionRate,
      marketAvgPrice: input.marketAvgPrice,
    };
    try {
      await this.snapshots.append(context, {
        entityType: "product",
        entityId: input.productId,
        calculationType: "pricing",
        idempotencyKey: deriveSnapshotIdempotencyKey({
          calculationType: "pricing",
          entityType: "product",
          entityId: input.productId,
          engineVersion: FINANCE_ENGINE_VERSION,
          inputs,
        }),
        inputs,
        outputs: JSON.parse(JSON.stringify({ priceFormation: input.priceFormation })) as Record<
          string,
          unknown
        >,
        engineVersion: FINANCE_ENGINE_VERSION,
      });
      applicationMetrics.snapshotCreatedTotal.add(1, { type: "pricing" });
    } catch (error) {
      applicationMetrics.snapshotFailureTotal.add(1, { type: "diagnostic" });
      logJson("warn", "diagnostic.snapshot_failed", {
        productId: input.productId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

export const pricingService: PricingService = new DefaultPricingService();
