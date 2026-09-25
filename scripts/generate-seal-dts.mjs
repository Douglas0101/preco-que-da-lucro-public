#!/usr/bin/env node
// Gera `scripts/m02-seal.d.mts` a partir de `scripts/m02-seal.mjs` (DBT-16).
//
// Por que existe: o `.d.mts` era mantido A MAO. O WP-R5 achou o custo disso — tres exports novos
// ficaram sem declaracao, o `vitest` passava (esbuild ignora a declaracao) e so o `tsc` reprovava.
// A trava de sincronia que entrou naquele WP compara NOMES; esta geracao elimina a classe inteira:
// o tipo passa a viver no JSDoc do modulo (fonte unica, ao lado do codigo) e o `.d.mts` vira
// artefato derivado. `--check` regenera num diretorio temporario e compara byte a byte, de modo que
// editar o `.d.mts` a mao deixa de ser possivel sem quebrar o gate.
//
// Node built-ins apenas; o `tsc` do proprio projeto e chamado como subprocesso.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MODULO = "scripts/m02-seal.mjs";
const DESTINO = "scripts/m02-seal.d.mts";

const CABECALHO = `// GERADO por scripts/generate-seal-dts.mjs a partir de ${MODULO} — nao edite a mao.
// A fonte dos tipos e o JSDoc do modulo; \`node scripts/generate-seal-dts.mjs --check\` reprova
// qualquer divergencia (DBT-16).
`;

/**
 * @param {string} root
 * @returns {string} o conteudo que o `.d.mts` deve ter
 */
export function renderDeclarations(root) {
  const tmp = mkdtempSync(join(tmpdir(), "seal-dts-"));
  try {
    const tsc = resolve(root, "node_modules/.bin/tsc");
    const r = spawnSync(
      tsc,
      [
        "--allowJs",
        "--declaration",
        "--emitDeclarationOnly",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2022",
        "--skipLibCheck",
        "--outDir",
        tmp,
        MODULO,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(`tsc falhou ao gerar as declaracoes:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    }
    // o tsc preserva o caminho relativo sob --outDir; procura o emitido onde ele estiver
    const achar = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const alvo = join(dir, e.name);
        if (e.isDirectory()) {
          const achado = achar(alvo);
          if (achado) return achado;
        } else if (e.name === "m02-seal.d.mts" || e.name === "m02-seal.d.ts") return alvo;
      }
      return undefined;
    };
    const caminho = achar(tmp);
    if (!caminho) throw new Error("tsc nao emitiu as declaracoes de m02-seal");
    // o shebang do modulo nao pode reaparecer no meio de um `.d.mts`
    const corpo = readFileSync(caminho, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("#!"))
      .join("\n");
    // o artefato tambem tem de passar no `format:check` do repo: formata com o prettier do projeto
    const prettier = resolve(root, "node_modules/.bin/prettier");
    const fmt = spawnSync(prettier, ["--stdin-filepath", DESTINO], {
      cwd: root,
      input: CABECALHO + corpo,
      encoding: "utf8",
    });
    if (fmt.status !== 0) throw new Error(`prettier falhou:\n${fmt.stderr ?? ""}`);
    return fmt.stdout;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @returns {{ ok: boolean, esperado: string, atual: string }}
 */
export function checkDeclarations(root, destino = DESTINO) {
  const esperado = renderDeclarations(root);
  let atual = "";
  try {
    atual = readFileSync(resolve(root, destino), "utf8");
  } catch {
    atual = "";
  }
  return { ok: atual === esperado, esperado, atual };
}

const invocadoDiretamente =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invocadoDiretamente) {
  const root = process.cwd();
  // `--destino` existe para o controle negativo do teste: apontar a conferencia para uma copia
  // mutada e exigir exit 1 (sem ele, o unico caminho seria mutar o arquivo versionado).
  const iDestino = process.argv.indexOf("--destino");
  const destino = iDestino === -1 ? DESTINO : process.argv[iDestino + 1];
  if (process.argv.includes("--write")) {
    writeFileSync(resolve(root, destino), renderDeclarations(root));
    console.log(`generate-seal-dts: ${destino} regenerado`);
  } else {
    const { ok, esperado, atual } = checkDeclarations(root, destino);
    if (!ok) {
      console.error(
        `generate-seal-dts: ${destino} divergiu do modulo (${atual.length} B no disco, ${esperado.length} B gerados).`,
      );
      console.error("Rode: node scripts/generate-seal-dts.mjs --write");
      process.exit(1);
    }
    console.log(`generate-seal-dts: ${destino} confere com o JSDoc de ${MODULO}`);
  }
}
