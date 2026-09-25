/**
 * §29 — disciplina de baseline: números de mock (`CONTROLLED`) e de tráfego
 * real (`OBSERVED`) nunca compartilham relatório, e provider real nunca recebe
 * rótulo `CONTROLLED` (com H-6 pendente a medição real é declarada como
 * `OBSERVED-UNAVAILABLE`, n = 0 — nunca estimada).
 *
 * Vocabulário de ambiente alinhado ao runbook `docs/runbooks/performance-evidence.md`
 * (`dev-evidence` | `CONTROLLED` | `OBSERVED`). Valida os JSONs versionados em
 * `docs/evidence/slo-ai-<data>/`; a ausência de violação é o que torna um
 * número citável em artefato de SLO.
 */

/** Rótulos de ambiente aceitos em um relatório de medição. */
export const BASELINE_REGIMES = ["dev-evidence", "CONTROLLED", "OBSERVED"] as const;
export type BaselineRegime = (typeof BASELINE_REGIMES)[number];

/** Medição declarada mas indisponível (aguarda H-6); nunca carrega amostras. */
export const UNAVAILABLE_REGIME = "OBSERVED-UNAVAILABLE";

/** `mock` = gateway/banco de teste; `real` = provider/harness de produção. */
export type BaselineProvider = "mock" | "real";

export interface BaselineSeries {
  name: string;
  regime: string;
  provider: string;
  n: number;
}

export interface UnavailableSeries {
  name: string;
  regime: string;
  provider: string;
  n: number;
  reason: string;
}

export interface BaselineReport {
  regime: string;
  provider: string;
  series: BaselineSeries[];
  unavailable?: UnavailableSeries[];
}

function isKnownRegime(value: string): value is BaselineRegime {
  return (BASELINE_REGIMES as readonly string[]).includes(value);
}

/**
 * Lista as violações de disciplina de um relatório; vazio = relatório citável.
 * Nunca lança: o chamador decide entre falhar o gate ou o gerador.
 */
export function findBaselineDisciplineViolations(report: BaselineReport): string[] {
  const violations: string[] = [];
  if (!isKnownRegime(report.regime)) {
    violations.push(
      `rótulo de ambiente desconhecido no relatório: ${report.regime} (esperado: ${BASELINE_REGIMES.join(", ")})`,
    );
  }
  for (const series of report.series) {
    if (series.regime !== report.regime) {
      violations.push(
        `${series.name}: regime ${series.regime} misturado com o relatório ${report.regime}`,
      );
    }
    if (series.provider === "real" && series.regime === "CONTROLLED") {
      violations.push(`${series.name}: rótulo CONTROLADO não pode rotular provider real`);
    }
  }
  if (report.regime === "CONTROLLED") {
    const mockOnly =
      report.provider === "mock" && report.series.every((series) => series.provider === "mock");
    if (!mockOnly) violations.push("relatório CONTROLADO exige provider mock em todas as séries");
  }
  if (report.regime === "OBSERVED") {
    if (report.provider !== "real") violations.push("relatório OBSERVED exige provider real");
    if (report.series.reduce((total, series) => total + series.n, 0) === 0) {
      violations.push("relatório OBSERVED sem amostras: medição real precisa de n > 0");
    }
  }
  for (const entry of report.unavailable ?? []) {
    if (entry.regime !== UNAVAILABLE_REGIME) {
      violations.push(
        `${entry.name}: indisponibilidade declarada precisa do rótulo ${UNAVAILABLE_REGIME}`,
      );
    }
    if (entry.regime === UNAVAILABLE_REGIME && entry.provider !== "real") {
      violations.push(`${entry.name}: ${UNAVAILABLE_REGIME} só se aplica a provider real`);
    }
    if (entry.n !== 0) {
      violations.push(
        `${entry.name}: ${UNAVAILABLE_REGIME} não pode carregar amostras (n=${entry.n})`,
      );
    }
    const measuredForProvider = report.series.some(
      (series) => series.name === entry.name && series.provider === entry.provider,
    );
    if (measuredForProvider) {
      violations.push(
        `${entry.name}: série medida e indisponível ao mesmo tempo para o provider ${entry.provider}`,
      );
    }
  }
  return violations;
}

/** Geradores falham fechado: um relatório fora da disciplina nunca é gravado. */
export function assertBaselineDiscipline(report: BaselineReport): void {
  const violations = findBaselineDisciplineViolations(report);
  if (violations.length > 0) {
    throw new Error(`baseline fora da disciplina do §29:\n- ${violations.join("\n- ")}`);
  }
}
