import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCoverage, parseTriggerLists } from "../../scripts/lib/m02-ci-coverage";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const heavyPath = resolve(root, ".github/workflows/ui-stack.yml");
const lightPath = resolve(root, ".github/workflows/ci-light.yml");
const heavyReal = readFileSync(heavyPath, "utf8");
const lightReal = readFileSync(lightPath, "utf8");

describe("cobertura de CI dos dois pipelines", () => {
  it("os workflows reais satisfazem o invariante (light.paths == heavy.paths-ignore)", () => {
    expect(auditCoverage(heavyReal, lightReal)).toEqual([]);
  });

  it("o parser extrai as listas de push e o PR irrestrito da heavy", () => {
    const heavy = parseTriggerLists(heavyReal);
    expect(heavy.pushPathsIgnore).toEqual(["docs/evidence/**"]);
    expect(heavy.pullRequestAny).toBe(true);
    const light = parseTriggerLists(lightReal);
    expect(light.pushPaths).toEqual(["docs/evidence/**"]);
    expect(light.pullRequestPaths).toEqual(["docs/evidence/**"]);
  });

  it("filtros divergentes entre os dois workflows reprovam", () => {
    const light = lightReal.replaceAll('"docs/evidence/**"', '"docs/**"');
    const findings = auditCoverage(heavyReal, light);
    expect(findings.join("\n")).toContain("light.push.paths");
  });

  it("heavy com pull_request filtrado reprova (PR docs-only escaparia dos dois)", () => {
    const heavy = heavyReal.replace(
      "  pull_request:\n",
      '  pull_request:\n    paths:\n      - "src/**"\n',
    );
    const findings = auditCoverage(heavy, lightReal);
    expect(findings.join("\n")).toContain("pull_request irrestrito");
  });

  it("heavy com pull_request filtrado por paths-ignore reprova", () => {
    const heavy = heavyReal.replace(
      "  pull_request:\n",
      '  pull_request:\n    paths-ignore:\n      - "src/**"\n',
    );
    expect(auditCoverage(heavy, lightReal).join("\n")).toContain("pull_request irrestrito");
  });

  it("guards só em comentário reprovam (o passo real tem de existir)", () => {
    const heavyComentado = heavyReal.replace(
      "      - run: npm run m02:debts-guard",
      "      # - run: npm run m02:debts-guard",
    );
    expect(auditCoverage(heavyComentado, lightReal).join("\n")).toContain("m02:debts-guard");
    const lightComentado = lightReal.replace(
      "        run: node scripts/m02-debts-guard.mjs",
      "        # run: node scripts/m02-debts-guard.mjs",
    );
    expect(auditCoverage(heavyReal, lightComentado).join("\n")).toContain("m02-debts-guard");
  });

  it("light sem lockfile guard, secrets audit ou prettier reprova", () => {
    const semLockfile = lightReal.replace(
      "        run: node scripts/m02-lockfile-guard.mjs",
      "        # run: node scripts/m02-lockfile-guard.mjs",
    );
    expect(auditCoverage(heavyReal, semLockfile).join("\n")).toContain("m02-lockfile-guard");
    const semSecrets = lightReal.replace(
      "        run: node scripts/m02-secrets-audit.ts",
      "        # run: node scripts/m02-secrets-audit.ts",
    );
    expect(auditCoverage(heavyReal, semSecrets).join("\n")).toContain("m02-secrets-audit");
    const semPrettier = lightReal.replace(
      'npx --yes "prettier@${version}" --check "${files[@]}"',
      "echo skip",
    );
    expect(auditCoverage(heavyReal, semPrettier).join("\n")).toContain("prettier");
  });

  it("guards ausentes em qualquer um dos lados reprovam", () => {
    const lightSemDebts = lightReal.replace(/.*m02-debts-guard.*\n/, "");
    expect(auditCoverage(heavyReal, lightSemDebts).join("\n")).toContain("m02-debts-guard");
    const heavySemWp = heavyReal.replace("      - run: npm run m02:work-package-guard\n", "");
    expect(auditCoverage(heavySemWp, lightReal).join("\n")).toContain("m02:work-package-guard");
  });

  it("light sem push.paths reprova (docs-only ficaria sem pipeline)", () => {
    const lightSemPaths = lightReal.replace(
      '  push:\n    paths:\n      - "docs/evidence/**"\n',
      "  push:\n",
    );
    expect(auditCoverage(heavyReal, lightSemPaths).join("\n")).toContain("light sem push.paths");
  });
});
