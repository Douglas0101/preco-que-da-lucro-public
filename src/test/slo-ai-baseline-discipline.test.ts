import { describe, expect, it } from "vitest";
import {
  findBaselineDisciplineViolations,
  UNAVAILABLE_REGIME,
} from "../../scripts/obs/baseline-regime";
import { verdictFor } from "../../scripts/obs/rum-percentiles";

const iaReport = {
  window: { started_at: "2026-09-12T10:45:51.597Z", ended_at: "2026-09-14T01:45:51.597Z" },
  regime: "CONTROLLED",
  provider: "mock",
  series: [
    {
      name: "app.ai.time_to_first_content",
      regime: "CONTROLLED",
      provider: "mock",
      n: 50,
      scenario: "mock-no-tool",
    },
    {
      name: "app.ai.time_to_final",
      regime: "CONTROLLED",
      provider: "mock",
      n: 50,
      scenario: "mock-no-tool",
    },
    {
      name: "app.ai.total_tokens",
      regime: "CONTROLLED",
      provider: "mock",
      n: 50,
      scenario: "mock-no-tool",
    },
    {
      name: "app.ai.time_to_first_content",
      regime: "CONTROLLED",
      provider: "mock",
      n: 50,
      scenario: "mock-tool-round",
    },
    {
      name: "app.ai.time_to_final",
      regime: "CONTROLLED",
      provider: "mock",
      n: 50,
      scenario: "mock-tool-round",
    },
    {
      name: "app.ai.total_tokens",
      regime: "CONTROLLED",
      provider: "mock",
      n: 50,
      scenario: "mock-tool-round",
    },
  ],
  unavailable: [
    {
      name: "app.ai.time_to_final",
      regime: UNAVAILABLE_REGIME,
      provider: "real",
      n: 0,
      reason: "H-6 pendente",
    },
    {
      name: "app.ai.time_to_first_content",
      regime: UNAVAILABLE_REGIME,
      provider: "real",
      n: 0,
      reason: "H-6 pendente",
    },
    {
      name: "app.ai.total_tokens",
      regime: UNAVAILABLE_REGIME,
      provider: "real",
      n: 0,
      reason: "H-6 pendente",
    },
  ],
};

const rumSource = {
  window: "7 days",
  min_samples: 20,
  targets: {
    LCP: { target: 2500, unit: "ms", label: "LCP ≤ 2,5 s" },
    INP: { target: 200, unit: "ms", label: "INP ≤ 200 ms" },
    CLS: { target: 0.1, unit: "", label: "CLS ≤ 0,1" },
  },
  rows: [
    {
      name: "LCP",
      n: 20,
      p75: 2000,
      verdict: "OK",
      window_start: "2026-09-12T10:45:51.597Z",
      window_end: "2026-09-14T01:45:51.597Z",
    },
    {
      name: "INP",
      n: 20,
      p75: 180,
      verdict: "OK",
      window_start: "2026-09-12T10:45:51.597Z",
      window_end: "2026-09-14T01:45:51.597Z",
    },
    {
      name: "CLS",
      n: 12,
      p75: 0.05,
      verdict: "N/A (N=12 < 20)",
      window_start: "2026-09-12T10:45:51.597Z",
      window_end: "2026-09-14T01:45:51.597Z",
    },
  ],
};

const frontendReport = {
  regime: "CONTROLLED",
  provider: "mock",
  window: rumSource.window,
  min_samples: rumSource.min_samples,
  targets: rumSource.targets,
  series: rumSource.rows.map((row) => ({
    name: row.name,
    regime: "CONTROLLED",
    provider: "mock",
    n: row.n,
    p75: row.p75,
    unit: rumSource.targets[row.name as keyof typeof rumSource.targets].unit,
    target: rumSource.targets[row.name as keyof typeof rumSource.targets].target,
    target_label: rumSource.targets[row.name as keyof typeof rumSource.targets].label,
    verdict: row.verdict,
    window_start: row.window_start,
    window_end: row.window_end,
  })),
};

const sloDoc = `# SLO AI\nCONTROLADO mock n = 50\nLCP ≤ 2,5 s INP ≤ 200 ms CLS ≤ 0,1\nOBSERVED-UNAVAILABLE H-6 OBSERVED\nOK N/A (N=12 < 20)\ntime_to_first_content == time_to_final\napp.ai.time_to_first_content mock-no-tool\napp.ai.time_to_final mock-no-tool\napp.ai.total_tokens mock-no-tool\napp.ai.time_to_first_content mock-tool-round\napp.ai.time_to_final mock-tool-round\napp.ai.total_tokens mock-tool-round\nN=20 N=20 N=12\n2026-09-12T10:45:51.597Z → 2026-09-14T01:45:51.597Z\ndocs/evidence/rum-p75-2026-09-13/raw.json\ndocs/evidence/slo-ai-2026-09-14/frontend-p75.json\n`;

// fixture parsing helpers are defined after their public contracts below

interface ArtifactSeries {
  name: string;
  scenario?: string;
  regime: string;
  provider: string;
  n: number;
  p75?: number;
  verdict?: string;
  window_start?: string;
  window_end?: string;
}

interface ArtifactUnavailable {
  name: string;
  regime: string;
  provider: string;
  n: number;
  reason: string;
}

function seriesOf(report: Record<string, unknown>): ArtifactSeries[] {
  return (report.series ?? []) as ArtifactSeries[];
}

function unavailableOf(report: Record<string, unknown>): ArtifactUnavailable[] {
  return (report.unavailable ?? []) as ArtifactUnavailable[];
}

/** Verifica o p75 com a função oficial de `scripts/obs/rum-percentiles.ts`. */
function officialVerdict(row: { name: string; n: number; p75: number }): string {
  return verdictFor(row as Parameters<typeof verdictFor>[0]);
}

describe("§29 — disciplina de baseline CONTROLADO (mock) × OBSERVED (provider real)", () => {
  it("rejeita números de mock e de provider real no mesmo relatório", () => {
    const violations = findBaselineDisciplineViolations({
      regime: "CONTROLLED",
      provider: "mock",
      series: [
        { name: "app.ai.time_to_final", regime: "CONTROLLED", provider: "mock", n: 50 },
        { name: "app.ai.time_to_final", regime: "OBSERVED", provider: "real", n: 40 },
      ],
    });

    expect(violations.join("\n")).toContain("misturado com o relatório CONTROLLED");
    expect(violations.join("\n")).toContain(
      "relatório CONTROLADO exige provider mock em todas as séries",
    );
  });

  it("rejeita rótulo CONTROLADO sobre provider real, mesmo sem mistura de séries", () => {
    const violations = findBaselineDisciplineViolations({
      regime: "CONTROLLED",
      provider: "real",
      series: [{ name: "app.ai.time_to_final", regime: "CONTROLLED", provider: "real", n: 40 }],
    });

    expect(violations).toContain(
      "app.ai.time_to_final: rótulo CONTROLADO não pode rotular provider real",
    );
    expect(violations.join("\n")).toContain("relatório CONTROLADO exige provider mock");
  });

  it("rejeita OBSERVED sem amostras e OBSERVED-UNAVAILABLE com amostras", () => {
    const semAmostras = findBaselineDisciplineViolations({
      regime: "OBSERVED",
      provider: "real",
      series: [{ name: "app.ai.time_to_final", regime: "OBSERVED", provider: "real", n: 0 }],
    });
    expect(semAmostras).toContain("relatório OBSERVED sem amostras: medição real precisa de n > 0");

    const indisponivelComAmostra = findBaselineDisciplineViolations({
      regime: "CONTROLLED",
      provider: "mock",
      series: [{ name: "app.ai.time_to_final", regime: "CONTROLLED", provider: "mock", n: 50 }],
      unavailable: [
        {
          name: "app.ai.time_to_final",
          regime: UNAVAILABLE_REGIME,
          provider: "real",
          n: 7,
          reason: "não deveria carregar amostras",
        },
      ],
    });
    expect(indisponivelComAmostra.join("\n")).toContain("não pode carregar amostras (n=7)");
  });

  it("aceita o baseline CONTROLADO do §29 (mock) com provider real declarado indisponível", () => {
    const ia = iaReport as unknown as Record<string, unknown>;
    expect(findBaselineDisciplineViolations(iaReport)).toEqual([]);
    expect(iaReport.regime).toBe("CONTROLLED");
    expect(iaReport.provider).toBe("mock");
    expect(seriesOf(ia).map((entry) => entry.scenario)).toEqual([
      "mock-no-tool",
      "mock-no-tool",
      "mock-no-tool",
      "mock-tool-round",
      "mock-tool-round",
      "mock-tool-round",
    ]);
    expect(unavailableOf(ia).map((entry) => entry.regime)).toEqual([
      UNAVAILABLE_REGIME,
      UNAVAILABLE_REGIME,
      UNAVAILABLE_REGIME,
    ]);
    expect(unavailableOf(ia).every((entry) => entry.n === 0)).toBe(true);
  });

  it("não versiona nenhuma amostra de provider real (OBSERVED inexistente sem H-6)", () => {
    const artifacts = [iaReport as unknown as Record<string, unknown>, frontendReport];
    for (const artifact of artifacts) {
      expect(artifact.provider).toBe("mock");
      expect(seriesOf(artifact).every((entry) => entry.provider === "mock")).toBe(true);
      expect(seriesOf(artifact).every((entry) => entry.regime === "CONTROLLED")).toBe(true);
      expect(
        unavailableOf(artifact).every(
          (entry) =>
            entry.provider === "real" && entry.regime === UNAVAILABLE_REGIME && entry.n === 0,
        ),
      ).toBe(true);
    }
  });

  it("deriva o p75 do frontend do raw fixture sem recriar limiares", () => {
    const report = frontendReport as unknown as Record<string, unknown>;
    expect(report.window).toBe(rumSource.window);
    expect(report.min_samples).toBe(rumSource.min_samples);
    expect(report.targets).toEqual(rumSource.targets);
    expect(seriesOf(report)).toEqual([
      {
        name: "LCP",
        regime: "CONTROLLED",
        provider: "mock",
        n: 20,
        p75: 2000,
        unit: "ms",
        target: 2500,
        target_label: "LCP ≤ 2,5 s",
        verdict: "OK",
        window_start: "2026-09-12T10:45:51.597Z",
        window_end: "2026-09-14T01:45:51.597Z",
      },
      {
        name: "INP",
        regime: "CONTROLLED",
        provider: "mock",
        n: 20,
        p75: 180,
        unit: "ms",
        target: 200,
        target_label: "INP ≤ 200 ms",
        verdict: "OK",
        window_start: "2026-09-12T10:45:51.597Z",
        window_end: "2026-09-14T01:45:51.597Z",
      },
      {
        name: "CLS",
        regime: "CONTROLLED",
        provider: "mock",
        n: 12,
        p75: 0.05,
        unit: "",
        target: 0.1,
        target_label: "CLS ≤ 0,1",
        verdict: "N/A (N=12 < 20)",
        window_start: "2026-09-12T10:45:51.597Z",
        window_end: "2026-09-14T01:45:51.597Z",
      },
    ]);
    for (const row of rumSource.rows) expect(officialVerdict(row)).toBe(row.verdict);
  });

  it("registra nos fixtures do §29 os alvos oficiais, N, janela e a lacuna H-6", () => {
    expect(sloDoc).toContain("CONTROLADO");
    expect(sloDoc).toContain("mock");
    expect(sloDoc).toContain("n = 50");
    expect(sloDoc).toContain("2026-09-12T10:45:51.597Z");
    expect(sloDoc).toContain("2026-09-14T01:45:51.597Z");
    for (const entry of frontendReport.series) expect(sloDoc).toContain(`N=${entry.n}`);
    expect(frontendReport.regime).toBe("CONTROLLED");
    for (const entry of iaReport.series) {
      expect(sloDoc).toContain(entry.name);
      expect(sloDoc).toContain(entry.scenario);
    }
    expect(sloDoc).toContain("time_to_first_content == time_to_final");
    expect(sloDoc).toContain("LCP ≤ 2,5 s");
    expect(sloDoc).toContain("INP ≤ 200 ms");
    expect(sloDoc).toContain("CLS ≤ 0,1");
    expect(sloDoc).toContain("OK");
    expect(sloDoc).toContain("N/A (N=12 < 20)");
    expect(sloDoc).toContain("OBSERVED-UNAVAILABLE");
    expect(sloDoc).toContain("H-6");
    expect(sloDoc).toContain("OBSERVED");
  });
});
