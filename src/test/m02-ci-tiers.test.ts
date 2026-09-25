import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflowSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const EXPECTED_USES = [`actions/checkout@${CHECKOUT_SHA}`, `actions/setup-node@${SETUP_NODE_SHA}`];
const EXPECTED_COMMANDS = [
  "npm install --global --ignore-scripts npm@11.14.1",
  "npm ci --ignore-scripts",
  "npm run check:public",
];
const EVIDENCE_GUARDS = ["m02:work-package-guard", "m02:debts-guard", "m02:temporal-guard"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicContractErrors(source: string): string[] {
  let workflow: unknown;
  try {
    workflow = parse(source);
  } catch {
    return ["workflow YAML must be valid"];
  }

  const rootObject = record(workflow);
  const triggers = record(rootObject?.on);
  const push = record(triggers?.push);
  const permissions = record(rootObject?.permissions);
  const jobs = record(rootObject?.jobs);
  const verify = record(jobs?.verify);
  const steps = Array.isArray(verify?.steps) ? verify.steps : undefined;
  const errors: string[] = [];

  if (
    !triggers ||
    !isDeepStrictEqual(Object.keys(triggers).sort(), ["pull_request", "push", "workflow_dispatch"])
  ) {
    errors.push("triggers must be exactly push, pull_request, and workflow_dispatch");
  }
  if (!push || !isDeepStrictEqual(push, { branches: ["main"] })) {
    errors.push("push must target exactly main");
  }
  if (!permissions || !isDeepStrictEqual(permissions, { contents: "read" })) {
    errors.push("permissions must be exactly contents: read");
  }
  if (!verify) {
    errors.push("verify job must exist");
  }
  if (verify?.["timeout-minutes"] !== 15) {
    errors.push("verify timeout must be 15 minutes");
  }
  if (!steps || steps.length !== 5) {
    errors.push("verify must contain exactly its five public steps");
    return errors;
  }

  const stepObjects = steps.map(record);
  const stepKeys = stepObjects.map((step) => (step ? Object.keys(step).sort() : []));
  if (
    !isDeepStrictEqual(stepKeys, [["uses", "with"], ["uses", "with"], ["run"], ["run"], ["run"]])
  ) {
    errors.push("verify steps must be exactly two pinned actions followed by three commands");
  }
  const uses = stepObjects
    .map((step) => step?.uses)
    .filter((use): use is string => typeof use === "string");
  const commands = stepObjects.map((step) => step?.run).filter((run): run is string => !!run);
  const checkout = stepObjects.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  const setupNode = stepObjects.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@"),
  );

  if (!isDeepStrictEqual(uses, EXPECTED_USES)) {
    errors.push(`action pins must be exactly ${EXPECTED_USES.join(", ")}`);
  }
  if (!isDeepStrictEqual(checkout?.with, { "fetch-depth": 0 })) {
    errors.push("checkout must fetch full history with fetch-depth: 0");
  }
  if (
    !record(setupNode?.with) ||
    !isDeepStrictEqual(setupNode?.with, { "node-version-file": ".nvmrc", cache: "npm" })
  ) {
    errors.push("setup-node must read .nvmrc and use the npm cache");
  }
  if (!isDeepStrictEqual(commands, EXPECTED_COMMANDS)) {
    errors.push(`run commands must be exactly ${EXPECTED_COMMANDS.join(" && ")}`);
  }
  if (commands.some((command) => EVIDENCE_GUARDS.some((guard) => command.includes(guard)))) {
    errors.push("evidence-dependent guard scripts must not run directly in public CI");
  }

  return errors;
}

describe("public single-workflow CI contract", () => {
  it("matches the real ci.yml public contract", () => {
    expect(publicContractErrors(workflowSource)).toEqual([]);
  });

  it.each([
    {
      drift: "checkout pin removal",
      source: workflowSource.replace(CHECKOUT_SHA, "v7.0.1"),
      finding: "action pins must be exactly",
    },
    {
      drift: "public check command removal",
      source: workflowSource.replace("npm run check:public", "npm test"),
      finding: "run commands must be exactly",
    },
    {
      drift: "pull request trigger removal",
      source: workflowSource.replace("  pull_request:\n", ""),
      finding: "triggers must be exactly",
    },
  ])("rejects $drift", ({ source, finding }) => {
    expect(publicContractErrors(source).join("\n")).toContain(finding);
  });

  it("rejects an evidence-dependent guard added directly to CI", () => {
    const mutated = workflowSource.replace(
      "npm run check:public",
      "npm run m02:work-package-guard && npm run check:public",
    );

    expect(publicContractErrors(mutated).join("\n")).toContain(
      "evidence-dependent guard scripts must not run directly in public CI",
    );
  });
});
