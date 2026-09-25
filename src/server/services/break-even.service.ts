/**
 * Serviço de ponto de equilíbrio (fronteira server).
 *
 * Fonte única da verdade: a implementação pura mora em @/lib/break-even
 * (client-safe, Decimal + @/lib/financial-values) e é reexportada aqui para o
 * server fn calculateBreakEven (break-even.functions.ts). Client e server
 * nunca divergem: paridade por construção. A persistência do calculation
 * snapshot permanece server fn, com engine version registrada server-side
 * no snapshot (INV-015).
 */
export {
  calculateBreakEvenSummary,
  type BreakEvenServiceError,
  type BreakEvenServiceInput,
  type BreakEvenServiceResult,
  type BreakEvenServiceStatus,
  type BreakEvenUnits,
} from "@/lib/break-even";
