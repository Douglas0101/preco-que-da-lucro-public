// Invariante de cobertura dos dois pipelines de CI (node built-ins only).
//
// A garantia contratada no AGENTS.md ("Coverage guarantee") vive em dois YAMLs:
// a light dispara para `docs/evidence/**` e a heavy ignora exatamente esses
// caminhos (o resto vai para o verify). Se alguém editar um filtro sem o outro,
// abre-se um buraco silencioso de cobertura — este modulo transforma o contrato
// em asserção: as listas tem de ser iguais, o PR da heavy tem de ser irrestrito
// e os guards de contrato tem de estar presentes nos dois caminhos.

export interface TriggerLists {
  pushPaths: string[];
  pushPathsIgnore: string[];
  pullRequestPaths: string[];
  pullRequestAny: boolean;
}

export function parseTriggerLists(yaml: string): TriggerLists {
  const result: TriggerLists = {
    pushPaths: [],
    pushPathsIgnore: [],
    pullRequestPaths: [],
    pullRequestAny: false,
  };
  let inOn = false;
  let event: "push" | "pull_request" | null = null;
  let key: "paths" | "paths-ignore" | null = null;

  for (const raw of yaml.split("\n")) {
    if (/^on:\s*$/.test(raw)) {
      inOn = true;
      event = null;
      key = null;
      continue;
    }
    if (!inOn) continue;
    if (/^\S/.test(raw)) {
      inOn = false;
      event = null;
      key = null;
      continue;
    }
    const indent = (/^ */.exec(raw) ?? [""])[0].length;
    const trimmed = raw.trim();
    if (indent === 2) {
      if (/^push:/.test(trimmed)) {
        event = "push";
      } else if (/^pull_request:/.test(trimmed)) {
        event = "pull_request";
        result.pullRequestAny = true;
      } else {
        event = null;
      }
      key = null;
      continue;
    }
    if (indent === 4 && event) {
      if (/^paths:/.test(trimmed)) {
        key = "paths";
        if (event === "pull_request") result.pullRequestAny = false;
      } else if (/^paths-ignore:/.test(trimmed)) {
        key = "paths-ignore";
        if (event === "pull_request") result.pullRequestAny = false;
      } else {
        key = null;
      }
      continue;
    }
    if (indent >= 6 && event && key) {
      const item = /^-\s*"?([^"]+)"?\s*$/.exec(trimmed);
      if (!item) continue;
      const value = item[1];
      if (event === "push" && key === "paths") result.pushPaths.push(value);
      if (event === "push" && key === "paths-ignore") result.pushPathsIgnore.push(value);
      if (event === "pull_request" && key === "paths") result.pullRequestPaths.push(value);
    }
  }
  return result;
}

export function auditCoverage(heavyYaml: string, lightYaml: string): string[] {
  const findings: string[] = [];
  const heavy = parseTriggerLists(heavyYaml);
  const light = parseTriggerLists(lightYaml);

  const heavyIgnore = [...heavy.pushPathsIgnore].sort().join(",");
  const lightPaths = [...light.pushPaths].sort().join(",");
  if (lightPaths.length === 0) {
    findings.push("light sem push.paths: docs-only ficaria sem pipeline");
  } else if (lightPaths !== heavyIgnore) {
    findings.push(
      `light.push.paths (${lightPaths}) != heavy.push.paths-ignore (${heavyIgnore}): a uniao dos filtros deixaria de cobrir todo push`,
    );
  }
  if (!heavy.pullRequestAny) {
    findings.push(
      "heavy sem pull_request irrestrito: PR docs-only poderia escapar dos dois pipelines",
    );
  }

  const checks: Array<[string, string, RegExp, string]> = [
    ["light", lightYaml, /^\s*run:\s*node scripts\/m02-lockfile-guard\.mjs/m, "m02-lockfile-guard"],
    [
      "light",
      lightYaml,
      /^\s*run:\s*node scripts\/m02-work-package-guard\.mjs/m,
      "m02-work-package-guard",
    ],
    ["light", lightYaml, /^\s*run:\s*node scripts\/m02-debts-guard\.mjs/m, "m02-debts-guard"],
    ["light", lightYaml, /^\s*run:\s*node scripts\/m02-secrets-audit\.ts/m, "m02-secrets-audit"],
    ["light", lightYaml, /npx --yes "prettier@/, "prettier"],
    ["heavy", heavyYaml, /^\s*- run:\s*npm run m02:work-package-guard/m, "m02:work-package-guard"],
    ["heavy", heavyYaml, /^\s*- run:\s*npm run m02:debts-guard/m, "m02:debts-guard"],
  ];
  for (const [lado, texto, padrao, nome] of checks) {
    if (!padrao.test(texto)) findings.push(`${lado} sem o check ${nome}`);
  }
  return findings;
}
