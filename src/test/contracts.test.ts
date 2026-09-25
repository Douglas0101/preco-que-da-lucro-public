import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ContractExpectation {
  path: string;
  exports: readonly string[];
}

const CONTRACTS: readonly ContractExpectation[] = [
  {
    path: "src/server/contracts/event.contracts.ts",
    exports: ["DomainEventInput", "AppendEventResult", "EventRepositoryPort"],
  },
  {
    path: "src/server/contracts/memory.contracts.ts",
    exports: ["MemoryRecord", "MemoryPolicy", "MemoryRepositoryPort"],
  },
  {
    path: "src/server/contracts/transaction.contracts.ts",
    exports: ["TransactionExecutor"],
  },
];

const FORBIDDEN_MODULES = ["@/db", "drizzle-orm", "src/server/repositories"];

function parseContract(path: string): ts.SourceFile {
  const source = readFileSync(resolve(process.cwd(), path), "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

function importedModules(source: ts.SourceFile): string[] {
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
}

function exportedTypeNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function isTypeOnly(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly === true;
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

function methodNames(source: ts.SourceFile, interfaceName: string): string[] {
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
  if (!declaration) return [];
  return declaration.members
    .filter(ts.isMethodSignature)
    .map((member) => member.name.getText(source));
}

describe("contratos PLANNED de Event (M-04) e Memory (M-05)", () => {
  it.each(CONTRACTS)("$path existe e exporta os nomes esperados", (contract) => {
    const names = exportedTypeNames(parseContract(contract.path));
    expect(names).toEqual(expect.arrayContaining([...contract.exports]));
  });

  it.each(CONTRACTS)("$path não importa @/db, drizzle-orm nem repositórios", (contract) => {
    const modules = importedModules(parseContract(contract.path));
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(modules.some((module) => module.startsWith(forbidden))).toBe(false);
    }
  });

  it.each(CONTRACTS)("$path é type-only (nenhum valor executável)", (contract) => {
    const source = parseContract(contract.path);
    expect(source.statements.length).toBeGreaterThan(0);
    expect(source.statements.filter((statement) => !isTypeOnly(statement))).toEqual([]);
  });

  it("EventRepositoryPort expõe append/publishPending verbatim da spec M-04", () => {
    const source = parseContract("src/server/contracts/event.contracts.ts");
    expect(methodNames(source, "EventRepositoryPort")).toEqual(["append", "publishPending"]);
  });

  it("MemoryRepositoryPort expõe append/search/delete", () => {
    const source = parseContract("src/server/contracts/memory.contracts.ts");
    expect(methodNames(source, "MemoryRepositoryPort")).toEqual(
      expect.arrayContaining(["append", "search", "delete"]),
    );
  });
});
