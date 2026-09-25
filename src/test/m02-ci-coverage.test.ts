import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ciReal = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const dependabotReal = readFileSync(resolve(root, ".github/dependabot.yml"), "utf8");

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validatePublicCi(source: string): string[] {
  const findings: string[] = [];
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    return ["public CI YAML must be valid"];
  }
  const workflow = record(parsed);
  const triggers = record(workflow?.on);
  const jobs = record(workflow?.jobs);
  const verify = record(jobs?.verify);
  const steps = Array.isArray(verify?.steps) ? verify.steps : [];

  if (
    !isDeepStrictEqual(triggers, {
      push: { branches: ["main"] },
      pull_request: null,
      workflow_dispatch: null,
    })
  ) {
    findings.push(
      "public CI triggers must be pushes to main, all pull requests, and manual dispatch",
    );
  }
  if (!isDeepStrictEqual(workflow?.permissions, { contents: "read" })) {
    findings.push("public CI permissions must be contents: read");
  }
  if (!verify || verify["timeout-minutes"] !== 15) {
    findings.push("public CI must define verify with timeout 15");
  }
  if (!steps.some((step) => record(step)?.run === "npm run check:public")) {
    findings.push("verify must run npm run check:public");
  }
  return findings;
}

interface DependabotUpdate {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  "open-pull-requests-limit": number;
}

function dependabotUpdates(source: string): DependabotUpdate[] {
  const parsed = record(parse(source));
  return Array.isArray(parsed?.updates) ? (parsed.updates as DependabotUpdate[]) : [];
}

function validateDependabot(source: string): string[] {
  const findings: string[] = [];
  if (record(parse(source))?.version !== 2) findings.push("Dependabot version must be 2");
  if (
    !isDeepStrictEqual(dependabotUpdates(source), [
      {
        "package-ecosystem": "npm",
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 10,
      },
      {
        "package-ecosystem": "github-actions",
        directory: "/",
        schedule: { interval: "weekly" },
        "open-pull-requests-limit": 5,
      },
    ])
  ) {
    findings.push(
      "Dependabot must update npm and github-actions weekly at root with limits 10 and 5",
    );
  }
  return findings;
}

function replaceExactly(source: string, from: string, to: string): string {
  const mutated = source.replace(from, to);
  expect(mutated).not.toBe(source);
  return mutated;
}

describe("contrato de CI do snapshot público", () => {
  it("aciona verify em pushes para main, todos os PRs e execução manual", () => {
    expect(validatePublicCi(ciReal)).toEqual([]);
  });

  it.each([
    ["push", "  push:\n    branches: [main]\n"],
    ["pull_request", "  pull_request:\n"],
    ["workflow_dispatch", "  workflow_dispatch:\n"],
  ])("reprova quando o gatilho público %s está ausente", (_trigger, block) => {
    expect(validatePublicCi(replaceExactly(ciReal, block, ""))).toContain(
      "public CI triggers must be pushes to main, all pull requests, and manual dispatch",
    );
  });

  it("configura semanalmente npm e github-actions na raiz com limites 10 e 5", () => {
    expect(validateDependabot(dependabotReal)).toEqual([]);
  });

  it.each([
    ["limite", "    open-pull-requests-limit: 10", "    open-pull-requests-limit: 9"],
    ["ecossistema", "  - package-ecosystem: npm", "  - package-ecosystem: pip"],
    ["intervalo", "      interval: weekly", "      interval: daily"],
  ])("reprova Dependabot com %s divergente", (_field, from, to) => {
    expect(validateDependabot(replaceExactly(dependabotReal, from, to))).toContain(
      "Dependabot must update npm and github-actions weekly at root with limits 10 and 5",
    );
  });
});
