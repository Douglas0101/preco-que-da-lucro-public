import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * §9.2 (PLANO:790-802) — teste A/B de **tipos**: o grafo de tipos do
 * `RequestContext` e dos contratos de repositório não pode alcançar o driver.
 *
 * Método (o mesmo A/B do verificador do ciclo 4, `WP-9.2R-VERDICT.md` §R3):
 * compila-se um programa isolado enraizado em `src/lib/request-context.ts` e em
 * `src/server/contracts/*.ts` com o mapeamento `@/db/*` apontando para um
 * diretório inexistente. Se qualquer módulo do grafo referenciar o driver, o
 * `tsc` acusa TS2307 — o resíduo R3 (`src/lib/request-context.ts:1` importava
 * `@/db/client.server`). O handle transacional é neutro: quem executa SQL o
 * estreita explicitamente para o tipo do driver dentro do adapter.
 */

/** Diretório que nunca existe: força TS2307 em qualquer import de `@/db/*`. */
const REMOVED_DRIVER_DIR = "removed-driver-for-type-graph-test";

/** Raízes do grafo que precisa ficar driver-agnostic. */
const DRIVER_FREE_ROOTS = [
  "src/lib/request-context.ts",
  "src/server/contracts/event.contracts.ts",
  "src/server/contracts/memory.contracts.ts",
  "src/server/contracts/product.contracts.ts",
  "src/server/contracts/transaction.contracts.ts",
];

/** Opções do `tsconfig.json` do projeto com `@/db/*` remapeado para o vazio. */
function remappedCompilerOptions(): ts.CompilerOptions {
  const configPath = resolve(process.cwd(), "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: process.cwd(),
    paths: {
      ...(parsed.options.paths ?? {}),
      "@/db/*": [`./${REMOVED_DRIVER_DIR}/*`],
    },
  };
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const file = diagnostic.file.fileName.replace(`${process.cwd()}/`, "");
  return `${file}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
}

/** Diagnósticos do programa isolado com o driver removido do grafo. */
function driverDiagnostics(): string[] {
  const options = remappedCompilerOptions();
  const program = ts.createProgram({
    rootNames: DRIVER_FREE_ROOTS.map((path) => resolve(process.cwd(), path)),
    options,
  });
  return ts.getPreEmitDiagnostics(program).map(formatDiagnostic);
}

describe("§9.2 — contexto e contratos não alcançam o driver (#R3)", () => {
  it("compila com @/db/* remapeado para um diretório inexistente", () => {
    expect(driverDiagnostics()).toEqual([]);
  });

  it("o remapeamento de fato removeria o driver (controle positivo)", () => {
    // Sem este controle, um `paths` malformado faria a asserção acima passar
    // por acidente: `@/db/client.server` PRECISA ficar irresolúvel.
    const resolution = ts.resolveModuleName(
      "@/db/client.server",
      resolve(process.cwd(), "src/lib/request-context.ts"),
      remappedCompilerOptions(),
      ts.sys,
    );
    expect(resolution.resolvedModule).toBeUndefined();
  });
});
