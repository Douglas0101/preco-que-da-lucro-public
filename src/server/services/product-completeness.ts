import type { ProductStatus } from "@/db/schema";
import type {
  CalculationError,
  CalculationResult,
  CalculationWarning,
  MissingField,
} from "@/lib/finance";

export type ProductCompleteness =
  | { status: "complete"; missing: []; warnings: CalculationWarning[] }
  | { status: "incomplete"; missing: MissingField[]; warnings: CalculationWarning[] }
  | { status: "invalid"; errors: CalculationError[] };

/** Projects calculation truth into the persisted product lifecycle without
 * turning an invalid or incomplete calculation into a ready product. */
export function productStatusFromCalculation(
  currentStatus: ProductStatus,
  result: CalculationResult<unknown>,
): ProductStatus {
  if (currentStatus === "archived") return "archived";
  if (result.status !== "ok") return "incomplete";
  return currentStatus === "active" ? "active" : "ready";
}

export function completenessFromCalculation(
  result: CalculationResult<unknown>,
): ProductCompleteness {
  if (result.status === "ok") {
    return { status: "complete", missing: [], warnings: result.warnings };
  }
  if (result.status === "incomplete") {
    return { status: "incomplete", missing: result.missing, warnings: result.warnings };
  }
  return { status: "invalid", errors: result.errors };
}
