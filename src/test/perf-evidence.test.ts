import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidenceRoot = join(root, "docs", "evidence");

const REQUIRED_LABELS = [
  "hypothesis",
  "metric",
  "before",
  "change",
  "after",
  "result",
  "decision",
] as const;

type RequiredLabel = (typeof REQUIRED_LABELS)[number];

const LABEL_PATTERNS = REQUIRED_LABELS.map((label) => ({
  label,
  pattern: new RegExp(`^\\s*(?:[-*]\\s*)?\\*\\*${label}\\s*:\\*\\*`, "im"),
}));

/**
 * SEM allowlist e SEM isenção de legado (WP-1c).
 *
 * Histórico do que foi removido: até o WP-1b (item `35`) este gate isentava dois
 * artefatos de 2026-08-29 — `perf-baseline-2026-08-29.md` e
 * `perf-after-2026-08-29.md`, regime `dev-evidence` publicado ANTES do gate
 * (commit `53f09e4`) — porque a fonte da medição vivia em
 * `/tmp/opencode/vite-dev.log` (não versionada) e preencher os 7 rótulos parecia
 * exigir inventar `before`/`after`/`metric`. A isenção era ancorada em CONTEÚDO
 * (o arquivo tinha de declarar o regime no corpo); nome sozinho não isentava.
 *
 * O WP-1c eliminou a isenção: os dois artefatos passaram a carregar o bloco §35
 * (cabeçalho obrigatório + os 7 rótulos) com os números transcritos das medições
 * já publicadas e `N/A` + lacuna declarada onde o log bruto não permite
 * re-derivar. Nenhum valor medido foi removido e nenhum número foi inventado.
 *
 * Invariante do gate (fail-closed nos dois sentidos): descoberta vazia REPROVA
 * (`EMPTY_DISCOVERY_FAILURE`) e TODO artefato descoberto é checado contra os 7
 * rótulos — `checked === discovered`, sem exceção (T4/T5).
 */

const EMPTY_DISCOVERY_FAILURE =
  "docs/evidence/**: descoberta vazia — nenhum artefato de evidência de performance encontrado; o gate §35 é fail-closed e REPROVA conjunto vazio (contrato em docs/evidence/_templates/performance-evidence.md)";

const SKIPPED_DIRS: Readonly<Record<string, true>> = { _templates: true, "agent-state": true };

/**
 * Contrato de §35 é de CAMINHO, não de basename: é artefato de evidência de
 * performance todo `.md` sob `docs/evidence/**` que (a) esteja dentro de um
 * diretório cujo nome começa com `perf-` (bundle de captura) ou (b) seja ele
 * mesmo `perf-*.md` / `*-perf-*.md`. O basename sozinho deixava escapar
 * `docs/evidence/perf-controlled-2026-09-13/report.md` (V2-CD, item `35`).
 *
 * Não varridos (`SKIPPED_DIRS`): `_templates` (esqueleto copiado) e
 * `agent-state/**` — árvore de fluxo de trabalho do programa SDD (SPEC-CARDS,
 * CLAIMS-INBOX, PROGRESS). Sem a segunda exclusão, nomes de fluxo mandatórios
 * como `35-perf-gate.md` (card e claim do item `35`) casariam a convenção
 * `*-perf-*` e reprovariam o gate por não carregarem os 7 rótulos, que são de
 * evidência de performance, não de fluxo.
 */
function isPerfEvidencePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? relativePath;
  if (!name.endsWith(".md")) return false;
  return segments.some((segment) => segment.startsWith("perf-")) || name.includes("-perf-");
}

function discoverPerfEvidence(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS[entry.name] === true) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(dir, full).split(sep).join("/");
      if (isPerfEvidencePath(relativePath)) found.push(relativePath);
    }
  };
  walk(dir);
  return found.sort();
}

function missingLabels(content: string): RequiredLabel[] {
  return LABEL_PATTERNS.filter(({ pattern }) => !pattern.test(content)).map(({ label }) => label);
}

interface PerfEvidenceAudit {
  discovered: string[];
  checked: string[];
  failures: string[];
}

function auditPerfEvidence(dir: string): PerfEvidenceAudit {
  const discovered = discoverPerfEvidence(dir);
  if (discovered.length === 0) {
    return { discovered, checked: [], failures: [EMPTY_DISCOVERY_FAILURE] };
  }
  const checked: string[] = [];
  const failures: string[] = [];
  for (const relativePath of discovered) {
    const content = readFileSync(join(dir, relativePath), "utf8");
    checked.push(relativePath);
    const missing = missingLabels(content);
    if (missing.length > 0) {
      failures.push(`docs/evidence/${relativePath}: rótulo(s) ausente(s): ${missing.join(", ")}`);
    }
  }
  return { discovered, checked, failures };
}

const fixtureRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "perf-evidence-"));
  fixtureRoots.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of fixtureRoots) rmSync(dir, { recursive: true, force: true });
});

/** Artefato contratado mínimo, com os 7 rótulos (§35). */
const CONTRACT_ARTIFACT = [
  "# Evidência de performance — fixture",
  "",
  "- **hypothesis:** fixture",
  "- **metric:** fixture",
  "- **before:** fixture",
  "- **change:** fixture",
  "- **after:** fixture",
  "- **result:** fixture",
  "- **decision:** fixture",
  "",
].join("\n");

function withoutLabel(content: string, label: RequiredLabel): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith(`- **${label}:**`))
    .join("\n");
}

describe("gate §35 — evidência de performance", () => {
  it("T1: descoberta vazia REPROVA (fail-closed)", () => {
    const dir = fixture({
      "_templates/performance-evidence.md": CONTRACT_ARTIFACT,
      "notas/sem-artefato.md": "# nada aqui",
    });
    const audit = auditPerfEvidence(dir);
    expect(audit.discovered).toEqual([]);
    expect(audit.failures.join("\n")).toMatch(/descoberta vazia|nenhum artefato/i);
  });

  it("T1b: diretório `perf-*` sem nenhum `.md` contratado REPROVA", () => {
    const dir = fixture({ "perf-so-raw-2026-01-01/raw.jsonl": "{}" });
    const audit = auditPerfEvidence(dir);
    expect(audit.discovered).toEqual([]);
    expect(audit.failures.length).toBeGreaterThan(0);
  });

  it("T2: falta de QUALQUER um dos 7 rótulos REPROVA (bundle `perf-*/report.md` incluído)", () => {
    for (const label of REQUIRED_LABELS) {
      const dir = fixture({
        "perf-x-2026-01-01/report.md": withoutLabel(CONTRACT_ARTIFACT, label),
      });
      const audit = auditPerfEvidence(dir);
      expect(audit.checked).toEqual(["perf-x-2026-01-01/report.md"]);
      expect(audit.failures.join("\n")).toContain(label);
    }
  });

  it("T3: artefato contratado completo PASSA (e o que está fora do contrato não é inspecionado)", () => {
    const dir = fixture({
      "perf-x-2026-01-01/perf-evidence.md": CONTRACT_ARTIFACT,
      "perf-y-2026-01-01/report.md": CONTRACT_ARTIFACT,
      "outras-notas.md": "# fora do contrato de caminho",
    });
    const audit = auditPerfEvidence(dir);
    expect(audit.failures).toEqual([]);
    expect(audit.checked).toEqual([
      "perf-x-2026-01-01/perf-evidence.md",
      "perf-y-2026-01-01/report.md",
    ]);
  });

  it("T4: NÃO existe isenção de legado — artefato de legado sem os 7 rótulos REPROVA", () => {
    // T4a: os dois caminhos que a allowlist isentava (WP-1c). Declarar o regime de
    // legado no corpo NÃO isenta mais: o arquivo tem de carregar os 7 rótulos.
    for (const legacyPath of ["perf-baseline-2026-08-29.md", "perf-after-2026-08-29.md"]) {
      const dir = fixture({ [legacyPath]: "> **RÓTULO GLOBAL: `dev-evidence`.**\n" });
      const audit = auditPerfEvidence(dir);
      expect(audit.checked).toEqual([legacyPath]);
      for (const label of REQUIRED_LABELS) {
        expect(audit.failures.join("\n")).toContain(label);
      }
    }
    // T4b: com os rótulos anexados (WP-1c), o mesmo caminho de legado passa como
    // qualquer artefato contratado — a isenção foi substituída por conformidade.
    const compliant = fixture({
      "perf-baseline-2026-08-29.md": CONTRACT_ARTIFACT,
      "perf-after-2026-08-29.md": CONTRACT_ARTIFACT,
    });
    const compliantAudit = auditPerfEvidence(compliant);
    expect(compliantAudit.checked).toEqual([
      "perf-after-2026-08-29.md",
      "perf-baseline-2026-08-29.md",
    ]);
    expect(compliantAudit.failures).toEqual([]);
  });

  it("T5: a árvore de evidência ausente no snapshot falha fechada", () => {
    const audit = auditPerfEvidence(evidenceRoot);
    expect(audit.discovered).toEqual([]);
    expect(audit.checked).toEqual([]);
    expect(audit.failures.join("\n")).toMatch(/descoberta vazia|nenhum artefato/i);
  });

  it("T6: artefato de FLUXO da missão sob `agent-state/**` não reprova; artefato real sem rótulo continua reprovando", () => {
    const dir = fixture({
      "agent-state/SPEC-CARDS/35-perf-gate.md": "# card da missão — fluxo, sem os 7 rótulos\n",
      "agent-state/CLAIMS-INBOX/35-perf-gate.md": "# claim da missão — fluxo, sem os 7 rótulos\n",
      "perf-captura-2026-01-01/report.md": withoutLabel(CONTRACT_ARTIFACT, "decision"),
    });
    const audit = auditPerfEvidence(dir);
    // (a) o artefato de fluxo não entra na varredura (nem reprova)…
    expect(audit.discovered).toEqual(["perf-captura-2026-01-01/report.md"]);
    expect(audit.failures.join("\n")).not.toContain("agent-state");
    // (b) …e o artefato real sem um rótulo continua reprovando (fail-closed preservado).
    expect(audit.checked).toEqual(["perf-captura-2026-01-01/report.md"]);
    expect(audit.failures.join("\n")).toContain("decision");
  });

  it("mantém os 7 rótulos no template de fixture", () => {
    expect(missingLabels(CONTRACT_ARTIFACT).join(", ")).toBe("");
  });
});
