import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyTransactionSite,
  isEntrypoint,
  transactionSites,
} from "../../scripts/lib/m02-transaction-sites";
import type { TransactionSiteSource } from "../../scripts/lib/m02-transaction-sites";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const REPOSITORY_PATH = "src/server/repositories/inventory.repository.ts";
const AUTH_PATH = "src/server/auth/membership.service.ts";
const FACADE_PATH = "src/lib/ai/tool-runner.ts";
const CONTRACT_PATH = "src/server/contracts/transaction.contracts.ts";

function scan(path: string, source: string) {
  return transactionSites([{ path, source }]);
}

function lines(source: readonly string[]): string {
  return source.join("\n");
}

describe("scanner M-02 de transaction sites", () => {
  it("conta uma entrada por referência de valor ao alias, não uma por declaração", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        'import type { DatabaseTransaction } from "@/db/client.server";',
        "export async function save(context: RequestContext) {",
        "  const tx = context.transaction as DatabaseTransaction;",
        '  await tx.insert(inventory).values({ sku: "a" });',
        '  await tx.update(inventory).set({ sku: "b" });',
        "  const rows = await tx.select().from(inventory);",
        "  return rows;",
        "}",
      ]),
    );

    expect(sites).toHaveLength(3);
    expect(sites.map((site) => site.line)).toEqual([4, 5, 6]);
    expect(sites.map((site) => site.path)).toEqual([
      REPOSITORY_PATH,
      REPOSITORY_PATH,
      REPOSITORY_PATH,
    ]);
    expect(new Set(sites.map((site) => site.expression))).toEqual(new Set(["context.transaction"]));
  });

  it("conta zero quando o alias não é referenciado e ignora sombreamento por parâmetro", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        "export async function save(context: RequestContext) {",
        "  const tx = context.transaction as DatabaseTransaction;",
        "  const shadow = (tx: Other) => tx.run();",
        "  return tx.select();",
        "}",
        "export function unused(context: RequestContext) {",
        "  const dead = context.transaction as DatabaseTransaction;",
        "  return 0;",
        "}",
      ]),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(4);
  });

  it("não conta comentários, nem em arquivo só-tipo", () => {
    const sites = scan(
      CONTRACT_PATH,
      lines([
        "/**",
        " * `RequestContext.transaction` é declarado por este tipo, então o grafo",
        " * (`context.transaction as DatabaseTransaction`) é asserção verificada.",
        " */",
        "// request.transaction jamais nasce aqui.",
        "export interface TransactionExecutor {",
        "  readonly execute: (...query: never[]) => unknown;",
        "}",
      ]),
    );

    expect(sites).toEqual([]);
  });

  it("não conta literais de string que mencionam o handle", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        'const probe = "context.transaction";',
        "const sql = `select note from t where note = 'request.transaction'`;",
        "export const keep = probe.length + sql.length;",
      ]),
    );

    expect(sites).toEqual([]);
  });

  it("não conta handle em posição de tipo", () => {
    const sites = scan(
      CONTRACT_PATH,
      lines([
        'import type { RequestContext } from "@/lib/request-context";',
        "export type TransactionHandle = typeof context.transaction;",
        "export interface TransactionExecutor {",
        "  readonly execute: (...query: never[]) => unknown;",
        "}",
      ]),
    );

    expect(sites).toEqual([]);
  });

  it("não varre src/test/**, que é código de teste", () => {
    const sites = scan(
      "src/test/event-service.test.ts",
      lines([
        'it("appenda no executor do contexto", async () => {',
        "  expect(repository.appends[0]?.executor).toBe(context.transaction);",
        "});",
      ]),
    );

    expect(sites).toEqual([]);
  });

  it("conta o uso direto do handle, sem alias", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        "export async function count(context: RequestContext) {",
        "  return (context.transaction as DatabaseTransaction).execute(sql`select 1`);",
        "}",
      ]),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(2);
  });

  it("é determinístico: duas execuções e a ordem de entrada não mudam os bytes", () => {
    const sources: TransactionSiteSource[] = [
      {
        path: REPOSITORY_PATH,
        source: lines(["const tx = context.transaction as T;", "tx.run();"]),
      },
      {
        path: AUTH_PATH,
        source: lines(["const tx = context.transaction as T;", "await tx.run();"]),
      },
      { path: FACADE_PATH, source: lines(["await request.transaction.run();"]) },
    ];

    const first = JSON.stringify(transactionSites(sources));
    const second = JSON.stringify(transactionSites(sources));
    const reversed = JSON.stringify(transactionSites([...sources].reverse()));

    expect(second).toBe(first);
    expect(reversed).toBe(first);
    expect(JSON.parse(first)).toHaveLength(3);
  });
});

describe("classificação dos transaction sites", () => {
  const alias = lines(["const tx = context.transaction as T;", "tx.run();"]);

  it("rotula pelo alvo da política, com evidência de runtime", () => {
    expect(scan(AUTH_PATH, alias)[0]?.classification).toBe("auth-allowlist");
    expect(scan(REPOSITORY_PATH, alias)[0]?.classification).toBe("repository-fallback");
    expect(scan(FACADE_PATH, alias)[0]?.classification).toBe("compatibility-facade");
  });

  it("rotula fallback de executor como repository-fallback mesmo fora de src/server/repositories", () => {
    const fallback = scan(
      FACADE_PATH,
      lines([
        "export function append(context: RequestContext, executor: Executor = context.transaction) {",
        "  return executor.insert(audit);",
        "}",
      ]),
    );

    expect(fallback).toHaveLength(1);
    expect(fallback[0].classification).toBe("repository-fallback");
  });

  it("rotula o lado direito de ?? como fallback de executor", () => {
    const fallback = scan(
      "src/server/services/event.service.ts",
      lines([
        "export function append(executor?: Executor) {",
        "  return run(executor ?? context.transaction);",
        "}",
      ]),
    );

    expect(fallback).toHaveLength(1);
    expect(fallback[0].classification).toBe("repository-fallback");
  });

  it("deixa o shape decidir antes do caminho", () => {
    expect(classifyTransactionSite({ path: AUTH_PATH, shape: "executor-fallback" })).toBe(
      "repository-fallback",
    );
    expect(classifyTransactionSite({ path: CONTRACT_PATH, shape: "direct-use" })).toBe(
      "compatibility-facade",
    );
  });
});

describe("bordas da semântica declarada (F-D1-scanner-borders)", () => {
  const ALIAS = "  const tx = context.transaction as DatabaseTransaction;";

  it("respeita sombreamento por declaração aninhada: o resto do bloco é do sombreador", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        "export async function save(context: RequestContext) {",
        ALIAS,
        "  await tx.a();",
        "  {",
        "    const tx = local;",
        "    await tx.b();",
        "  }",
        "  await tx.c();",
        "}",
      ]),
    );

    // `tx.b()` pertence ao `tx` local: o bloco sombreador inteiro sai da conta.
    expect(sites.map((site) => site.line)).toEqual([3, 8]);
  });

  it("não conta referência ao alias em posição de tipo", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        "export async function save(context: RequestContext) {",
        ALIAS,
        "  type Handle = typeof tx;",
        "  return tx.select();",
        "}",
      ]),
    );

    expect(sites.map((site) => site.line)).toEqual([4]);
  });

  it("não rotula de fallback o handle à esquerda da coalescência", () => {
    const left = scan(
      AUTH_PATH,
      lines([
        "export function pick(context: RequestContext, fallback: Executor) {",
        "  return context.transaction ?? fallback;",
        "}",
      ]),
    );

    expect(left).toHaveLength(1);
    expect(left[0].classification).toBe("auth-allowlist");
  });

  it("trata o operador de atribuição como fallback quando o handle está à direita", () => {
    const sites = scan(
      "src/server/services/event.service.ts",
      lines([
        "export function append(executor?: Executor) {",
        "  executor ??= context.transaction;",
        "  return executor.insert(audit);",
        "}",
      ]),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0].classification).toBe("repository-fallback");
  });

  it("cobre os quatro operadores de fallback, nos dois lados", () => {
    // Lado DIREITO: `||` e `||=` são fallback, como `??` e `??=`.
    const right = scan(
      AUTH_PATH,
      lines([
        "export function pick(context: RequestContext, fallback: Executor) {",
        "  const a = fallback || context.transaction;",
        "  fallback ||= context.transaction;",
        "  return a;",
        "}",
      ]),
    );

    expect(right.map((site) => site.line)).toEqual([2, 3]);
    expect(right.every((site) => site.classification === "repository-fallback")).toBe(true);

    // Lado ESQUERDO: o handle é o primário — nunca fallback, para nenhum dos quatro.
    const left = scan(
      AUTH_PATH,
      lines([
        "export function pick(context: RequestContext, fallback: Executor) {",
        "  const a = context.transaction || fallback;",
        "  context.transaction ??= fallback;",
        "  return a;",
        "}",
      ]),
    );

    expect(left.map((site) => site.line)).toEqual([2, 3]);
    expect(left.every((site) => site.classification === "auth-allowlist")).toBe(true);
  });

  it("não poda as referências do próprio alias quando ele nasce no cabeçalho de um for", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        "export async function save(context: RequestContext) {",
        "  for (const tx = context.transaction; ready(); ) {",
        "    await tx.select();",
        "  }",
        "}",
      ]),
    );

    // O alias é declarado no for, mas o `tx` do corpo É o alias: não é sombra.
    expect(sites.map((site) => site.line)).toEqual([3]);
  });

  it("respeita sombreamento por cabeçalho de for e por catch, sem apagar o irmão legítimo", () => {
    const sites = scan(
      REPOSITORY_PATH,
      lines([
        "export async function save(context: RequestContext, xs: Other[]) {",
        ALIAS,
        "  for (const tx of xs) { tx.run(); }",
        "  try { await tx.select(); } catch (tx) { tx.report(); }",
        "}",
      ]),
    );

    // O `tx` do laço e o do `catch` são outros escopos; o `tx.select()` é do alias.
    expect(sites.map((site) => site.line)).toEqual([4]);
  });
});

describe("guarda de entrypoint de scripts/m02-matrix.ts", () => {
  it("só reconhece o próprio módulo em argv[1]", () => {
    expect(isEntrypoint(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
    expect(isEntrypoint(import.meta.url, resolve(root, "scripts/m02-matrix.ts"))).toBe(false);
    expect(isEntrypoint(import.meta.url, undefined)).toBe(false);
  });

  it("importar o gerador não regrava a matriz", async () => {
    const matrixFiles = ["matrix.yaml", "matrix.generated.yaml"].map((name) =>
      resolve(root, "docs/specs/M-02", name),
    );
    const before = matrixFiles.map((path) => ({
      bytes: readFileSync(path),
      mtimeMs: statSync(path).mtimeMs,
    }));

    // Import dinâmico deliberado: o teste mede o efeito colateral da carga do
    // módulo e um import estático seria içado para antes do snapshot.
    await import("../../scripts/m02-matrix");

    for (const [index, path] of matrixFiles.entries()) {
      expect(readFileSync(path)).toEqual(before[index].bytes);
      expect(statSync(path).mtimeMs).toBe(before[index].mtimeMs);
    }
  });
});
