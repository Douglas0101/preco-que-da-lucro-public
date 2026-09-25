// F-D2-runner-failopen (lado vitest): `src/test/product-contracts.test.ts` tem 14
// casos, dos quais 9 são gated por banco (`dbDescribe`). Nenhum passo assertava que
// eles **executaram** — se o gate de loopback fechasse, o arquivo viraria
// `5 passed | 9 skipped` com exit 0 e `npm run test` seguiria verde sem ter
// exercitado o banco. Este passo encadeia a prova na suíte de banco e falha alto em
// três casos:
//
//   1. `DATABASE_ADMIN_URL` ausente (`requireAdminUrl`);
//   2. o bloco de banco ter sido **pulado**: o resumo do reporter JSON precisa ter
//      0 testes pendentes. Desde o WP-R6 o gate do teste é `dbPrecondition()`
//      (`src/test/helpers/db-precondition.ts`): **tudo ou nada, e falha alta** —
//      nenhuma URL definida ⇒ o bloco pula (e o pending abaixo reprova); qualquer
//      uma definida ⇒ o par `DATABASE_ADMIN_URL` + `DATABASE_URL` é exigido em
//      loopback, e `DATABASE_URL_UNPOOLED` é validada se definida (é o kill-switch
//      contra credencial de produção herdada). A versão anterior devolvia `true`
//      para valor ausente e por isso o bloco **executava** com uma URL faltando;
//      aquele comportamento foi substituído de propósito. Medido em 2026-09-21:
//      par em loopback ⇒ `14 total / 14 passed / 0 pending`; `DATABASE_URL_UNPOOLED`
//      remota ⇒ reprova alto nomeando a chave;
//   3. a cardinalidade do arquivo ter encolhido. Um arquivo **sem** casos faz o
//      vitest sair != 0, e a asserção de status abaixo já reprova antes das demais.
//      Mas um arquivo com menos casos que o contrato — **todos passando** — sai 0, e
//      o passo ficaria verde com a cobertura de banco reduzida em silêncio. Medido:
//      1 caso que passa ⇒ `1 < 14` e exit 1. É isso que o piso fecha.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAdminUrl } from "./migrate";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const testFile = "src/test/product-contracts.test.ts";

/**
 * Piso de cardinalidade do arquivo (F-D2-runner-failopen). O runner já reprova
 * quando o vitest sai != 0 — um arquivo sem casos cai aí — mas um arquivo com menos
 * casos que o contrato, **todos passando**, sai 0 e o passo ficaria verde com a
 * cobertura encolhida em silêncio. Medido em 2026-09-19: arquivo com 1 caso que
 * passa ⇒ `1 < 14` e exit 1.
 */
const MIN_TOTAL_TESTS = 14;

/** Resumo do reporter JSON do vitest (só o que este passo lê). */
interface VitestSummary {
  numTotalTests: number;
  numPassedTests: number;
  numPendingTests: number;
  numFailedTests: number;
}

function vitestBin(): string {
  const bin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  assert.ok(existsSync(bin), `vitest não encontrado em ${bin} (rode npm ci)`);
  return bin;
}

async function main(): Promise<void> {
  const adminUrl = requireAdminUrl();
  const scratch = mkdtempSync(join(tmpdir(), "trk-d2-pc-"));
  const summaryPath = join(scratch, "summary.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestBin(),
        "run",
        testFile,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${summaryPath}`,
      ],
      { cwd: repoRoot, stdio: "inherit", env: process.env },
    );
    assert.equal(result.error, undefined, `falha ao executar o vitest: ${result.error?.message}`);
    assert.equal(result.signal, null, `vitest terminou por sinal ${result.signal}`);
    assert.equal(
      result.status,
      0,
      `a prova de banco reprovou (exit ${result.status}); ver a saída do vitest acima`,
    );

    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as VitestSummary;
    assert.ok(
      summary.numTotalTests >= MIN_TOTAL_TESTS,
      `a prova de banco não produziu casos suficientes: ${summary.numTotalTests} < ${MIN_TOTAL_TESTS} ` +
        "— um arquivo com menos casos que o contrato, todos passando, sairia 0 e " +
        "deixaria o passo verde com a cobertura de banco encolhida em silêncio " +
        "(fail-open, F-D2-runner-failopen)",
    );
    assert.equal(summary.numFailedTests, 0, "a prova de banco reprovou (ver a saída acima)");
    assert.equal(
      summary.numPendingTests,
      0,
      `a prova de banco foi pulada (${summary.numPendingTests} testes pendentes): ` +
        "o gate de loopback do teste exige DATABASE_ADMIN_URL local, e DATABASE_URL/" +
        "DATABASE_URL_UNPOOLED locais quando definidas — nenhuma URL remota pode " +
        "segurar uma credencial de produção aqui",
    );
    assert.equal(
      summary.numPassedTests,
      summary.numTotalTests,
      `prova de banco incompleta: ${summary.numPassedTests}/${summary.numTotalTests}`,
    );
    console.log(
      `prova de banco (${testFile}) contra 127.0.0.1: ${summary.numPassedTests} passed ` +
        `(${summary.numTotalTests}), 0 skipped — admin=${new URL(adminUrl).host}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
