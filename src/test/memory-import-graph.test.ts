import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * INV-005: a memória da IA **não** substitui nem alimenta dado financeiro
 * canônico. A asserção é de grafo de import — não de comentário:
 *
 *  1. nenhum módulo de memória importa o Financial Engine (nem `import type`);
 *  2. o fecho de runtime dos módulos de memória não alcança o Financial Engine;
 *  3. os módulos de memória não importam `@/db` nem `drizzle-orm` (o degrau D1 é
 *     puramente de domínio, sem persistência);
 *  4. **nenhum cálculo canônico consome saída de memória**, onde "cálculo
 *     canônico" é **derivado do grafo** (todo módulo de `src/` que alcança o
 *     motor financeiro), não uma lista fixa de raízes.
 */
const ROOT = process.cwd();

const MEMORY_MODULES = [
  "src/server/services/memory.service.ts",
  "src/server/services/memory.policy.ts",
  "src/server/contracts/memory.contracts.ts",
] as const;

/** Motor financeiro puro (§INV-004): os módulos sob `src/lib/financ*`. */
const FINANCE_ENGINE_PATTERN = /^src\/lib\/financ/;

/** Módulos de produção de `src/` — o universo do grafo (testes ficam de fora
 * porque não são runtime do produto). */
function productionModules(): string[] {
  const modules: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (path === "src/test") continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      modules.push(path);
    }
  };
  walk("src");
  return modules;
}

const MODULES = productionModules();
const FINANCE_ENGINE_MODULES = MODULES.filter((module) => FINANCE_ENGINE_PATTERN.test(module));

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

const edgeCache = new Map<string, readonly ImportEdge[]>();

function edgesOf(relativePath: string): readonly ImportEdge[] {
  const cached = edgeCache.get(relativePath);
  if (cached) return cached;

  const source = ts.createSourceFile(
    relativePath,
    readFileSync(join(ROOT, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const edges: ImportEdge[] = [];

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      edges.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: statement.importClause?.isTypeOnly ?? false,
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      edges.push({ specifier: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly });
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      edges.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  edgeCache.set(relativePath, edges);
  return edges;
}

/** Resolve `@/x` e caminhos relativos para um arquivo do repositório; pacotes
 * externos retornam `null`. */
function resolveSpecifier(fromRelativePath: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(ROOT, dirname(fromRelativePath), specifier);
  else return null;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(ROOT, candidate);
  }
  return null;
}

function resolvedTargets(relativePath: string, options: { includeTypeOnly: boolean }): string[] {
  return edgesOf(relativePath)
    .filter((edge) => options.includeTypeOnly || !edge.typeOnly)
    .map((edge) => resolveSpecifier(relativePath, edge.specifier))
    .filter((target): target is string => target !== null);
}

/** Fecho de runtime a partir das raízes (BFS). */
function forwardClosure(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const target of resolvedTargets(current, { includeTypeOnly: false })) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return [...seen];
}

/** Fecho reverso: os módulos (do universo de produção) que alcançam algum dos
 * `targets` — derivado do grafo, nunca de lista fixa. */
function reverseReachable(targets: readonly string[]): string[] {
  const importersOf = new Map<string, string[]>();
  for (const module of MODULES) {
    for (const target of resolvedTargets(module, { includeTypeOnly: false })) {
      const importers = importersOf.get(target);
      if (importers) importers.push(module);
      else importersOf.set(target, [module]);
    }
  }

  const reachable = new Set<string>(targets);
  const queue = [...targets];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const importer of importersOf.get(current) ?? []) {
      if (reachable.has(importer)) continue;
      reachable.add(importer);
      queue.push(importer);
    }
  }
  return [...reachable];
}

let canonicalCache: string[] | null = null;

/** Cálculo canônico = motor financeiro + quem o consome (direto ou indireto). */
function canonicalCalculators(): string[] {
  if (canonicalCache === null) canonicalCache = reverseReachable(FINANCE_ENGINE_MODULES);
  return canonicalCache;
}

let reachingMemoryCache: string[] | null = null;

/** Módulos de produção que alcançam algum módulo de memória. */
function reachingMemory(): string[] {
  if (reachingMemoryCache === null) reachingMemoryCache = reverseReachable(MEMORY_MODULES);
  return reachingMemoryCache;
}

describe("INV-005 — grafo de import da memória", () => {
  it("os módulos analisados existem e resolvem (senão a asserção seria vacua)", () => {
    for (const module of MEMORY_MODULES) {
      expect(existsSync(join(ROOT, module)), `${module} não existe`).toBe(true);
    }
    expect(FINANCE_ENGINE_MODULES.length).toBeGreaterThan(0);
    expect(FINANCE_ENGINE_MODULES).toContain("src/lib/finance.ts");
    expect(MODULES.length).toBeGreaterThan(100);
    expect(resolveSpecifier("src/server/services/memory.service.ts", "@/lib/api-error")).toBe(
      "src/lib/api-error.ts",
    );
  });

  it("nenhum módulo de memória importa o Financial Engine — nem como tipo", () => {
    for (const module of MEMORY_MODULES) {
      for (const edge of edgesOf(module)) {
        expect(edge.specifier, `${module} → ${edge.specifier}`).not.toMatch(/financ/i);
        const target = resolveSpecifier(module, edge.specifier);
        if (target)
          expect(FINANCE_ENGINE_PATTERN.test(target), `${module} → ${target}`).toBe(false);
      }
    }
  });

  it("o fecho de runtime da memória não alcança o Financial Engine", () => {
    const closure = forwardClosure(MEMORY_MODULES);

    // Poder discriminante: o percurso realmente andou — do serviço até a policy e
    // da policy até a fronteira de erro.
    expect(closure).toEqual(
      expect.arrayContaining(["src/server/services/memory.policy.ts", "src/lib/api-error.ts"]),
    );
    expect(closure.filter((path) => FINANCE_ENGINE_PATTERN.test(path))).toEqual([]);
  });

  it("o fecho de runtime dos módulos de memória não importa @/db nem drizzle-orm", () => {
    for (const module of MEMORY_MODULES) {
      for (const edge of edgesOf(module)) {
        expect(edge.specifier.startsWith("@/db"), `${module} → ${edge.specifier}`).toBe(false);
        expect(edge.specifier.startsWith("drizzle-orm"), `${module} → ${edge.specifier}`).toBe(
          false,
        );
      }
    }

    const closure = forwardClosure(MEMORY_MODULES);
    expect(closure.filter((path) => path.startsWith("src/db/"))).toEqual([]);
  });

  it("as raízes do cálculo canônico são derivadas do grafo (conjunto não vazio e fail-closed)", () => {
    const canonical = canonicalCalculators();

    // Guarda contra a derivação encolher em silêncio: quem consome o motor
    // financeiro hoje precisa continuar sendo enxergado pelo grafo.
    expect(canonical).toEqual(
      expect.arrayContaining([
        "src/lib/finance.ts",
        "src/server/services/financial.service.ts",
        "src/server/services/simulation.service.ts",
        "src/server/services/pricing.service.ts",
        "src/server/services/dashboard.service.ts",
        "src/server/services/product-read-model.service.ts",
        "src/lib/break-even.ts",
      ]),
    );
    expect(canonical.length).toBeGreaterThanOrEqual(15);
  });

  it("nenhuma saída de memória é consumida pelo cálculo canônico", () => {
    const reaching = new Set(reachingMemory());
    const consumers = canonicalCalculators().filter((module) => reaching.has(module));

    expect(consumers).toEqual([]);

    for (const module of canonicalCalculators()) {
      for (const edge of edgesOf(module)) {
        const target = resolveSpecifier(module, edge.specifier);
        if (target)
          expect(
            (MEMORY_MODULES as readonly string[]).includes(target),
            `${module} → ${target}`,
          ).toBe(false);
      }
    }
  });
});
