#!/usr/bin/env node
/**
 * check:sdd-drift — referências cruzadas entre o design e o código.
 *
 * Duas verificações, escolhidas por serem as que existem **como dado** hoje:
 *
 * 1. **Referência de ADR.** Todo caminho `docs/adr/ADR-NNN-*.md` citado em
 *    qualquer lugar do repositório tem de resolver para um arquivo que exista,
 *    idem para link relativo `](adr/ADR-NNN-*.md)`. Isto é o que pegaria uma
 *    migração de ADR feita sem gate: há 211 citações de ID em 48 arquivos e
 *    nenhum outro teste do repositório valida o caminho — a operação passaria
 *    verde com referência morta.
 *
 * 2. **Invariante declarado.** Todo `INV-NNN` citado no repositório tem de
 *    constar no registro canônico (Plano Mestre §3 ∪ Diretriz V7 §25). Sem
 *    isso, um ID inventado numa linha de teste passa a parecer oficial.
 *
 * As duas são *verificações de existência*, não de mérito: o gate não avalia
 * se o ADR está certo nem se a invariante vale — isso é revisão. Aqui ele só
 * garante que a referência aponta para algo que existe.
 *
 * Falha fechada, no padrão de `scripts/m02-temporal-guard.mjs`:
 *   exit 2 — pré-condição não satisfeita (superfície ausente, descoberta vazia)
 *   exit 1 — violação (referência morta, ID fora do registro)
 *   exit 0 — tudo verde
 *
 * Descoberta vazia reprova: se o registro sumisse, o gate não pode sair `0`
 * sem ter olhado nada — seria cobertura aparente, o defeito que este repositório
 * já condenou no `m02-secrets-audit`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_VIOLACAO = 1;
export const EXIT_PRECONDICAO = 2;

/** Registro canônico das invariantes. Os dois documentos declaram os mesmos
 * 22 IDs; a união é a fonte porque a redação prevalecente é a da V7 e o Plano
 * traz a tabela original — divergir entre si também é violação. */
export const REGISTRO_INV = [
  "docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md",
  "docs/DIRETRIZ_PRECIFICA_PRECO_QUE_DA_LUCRO_V7_SHADCN_BASEUI_SINCRONIZADO_OFICIAL.md",
];

/** Nada disto é fonte de design, e todos pesam dezenas de milhares de arquivos. */
const IGNORADOS = new Set([
  ".git",
  "node_modules",
  ".output",
  ".artifacts",
  "artifacts",
  "dist",
  ".tanstack",
  "coverage",
  "playwright-report",
  "test-results",
  ".playwright-mcp",
  ".p0-closeout-docker",
]);

const EXTENSOES_DE_TEXTO = new Set([
  ".md",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".yml",
  ".yaml",
  ".json",
  ".sh",
  ".sql",
  ".txt",
]);

/** Absoluto: captura o caminho inteiro (`docs/adr/x.md`). Relativo: captura só
 * o arquivo, porque o `adr/` é resolvido contra o documento que o contém. */
const RE_ADR_ABS = /(docs\/adr\/ADR-\d{3}[a-z0-9-]*\.md)/g;
const RE_ADR_REL = /\]\((?:\.\/)?adr\/(ADR-\d{3}[a-z0-9-]*\.md)\)/g;
const RE_INV = /\bINV-\d{3}\b/g;

function listarTextos(root, saida = []) {
  for (const entry of readdirSync(root)) {
    if (IGNORADOS.has(entry) || entry.startsWith(".worktree-")) continue;
    const caminho = join(root, entry);
    const info = statSync(caminho, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory()) {
      listarTextos(caminho, saida);
      continue;
    }
    const ponto = entry.lastIndexOf(".");
    if (ponto >= 0 && EXTENSOES_DE_TEXTO.has(entry.slice(ponto))) saida.push(caminho);
  }
  return saida;
}

function unicos(valores) {
  return [...new Set(valores)].sort();
}

/** Check 1 — cada caminho de ADR citado resolve para um arquivo existente. */
export function auditarReferenciasAdr(root, arquivos) {
  const mortas = [];
  let descobertas = 0;

  for (const arquivo of arquivos) {
    const relativo = arquivo.slice(root.length + 1);
    const conteudo = readFileSync(arquivo, "utf8");

    for (const re of [RE_ADR_ABS, RE_ADR_REL]) {
      re.lastIndex = 0;
      let achado;
      while ((achado = re.exec(conteudo)) !== null) {
        descobertas += 1;
        // Um link `](adr/x.md)` é relativo ao documento que o contém; um
        // caminho `docs/adr/x.md` é relativo à raiz.
        const alvo =
          re === RE_ADR_ABS ? join(root, achado[1]) : join(dirname(arquivo), "adr", achado[1]);
        if (!exists(alvo)) {
          const linha = conteudo.slice(0, achado.index).split("\n").length;
          mortas.push({
            arquivo: relativo,
            linha,
            referencia: achado[1],
            alvo: alvo.slice(root.length + 1),
          });
        }
      }
    }
  }
  return { descobertas, mortas };
}

/** Check 2 — todo INV citado consta no registro canônico. */
export function auditarInvariantes(root, arquivos) {
  const declarados = new Set();
  const fora = [];

  for (const nome of REGISTRO_INV) {
    const caminho = join(root, nome);
    if (!exists(caminho)) {
      return {
        precondicao: `registro de invariantes ausente: ${nome}`,
        declarados: [],
        citados: [],
        fora: [],
      };
    }
    for (const id of readFileSync(caminho, "utf8").match(RE_INV) ?? []) declarados.add(id);
  }
  if (declarados.size === 0) {
    return {
      precondicao: "registro de invariantes sem nenhum ID declarado",
      declarados: [],
      citados: [],
      fora: [],
    };
  }

  const citados = new Set();
  for (const arquivo of arquivos) {
    const relativo = arquivo.slice(root.length + 1);
    // O registro é a fonte: citar nele não é violação.
    if (REGISTRO_INV.includes(relativo)) continue;
    const conteudo = readFileSync(arquivo, "utf8");
    for (const id of conteudo.match(RE_INV) ?? []) {
      citados.add(id);
      if (!declarados.has(id)) {
        const linha = conteudo.slice(0, conteudo.indexOf(id)).split("\n").length;
        fora.push({ arquivo: relativo, linha, id });
      }
    }
  }
  if (citados.size === 0) {
    return {
      precondicao: "nenhuma invariante citada no repositório — nada a validar",
      declarados: [...declarados],
      citados: [],
      fora: [],
    };
  }
  return { precondicao: null, declarados: unicos(declarados), citados: unicos(citados), fora };
}

export function auditar(root) {
  const arquivos = listarTextos(root);
  if (arquivos.length === 0) {
    return {
      exit: EXIT_PRECONDICAO,
      mensagens: [`precondicao: nenhum arquivo de texto sob ${root}`],
    };
  }

  const adr = auditarReferenciasAdr(root, arquivos);
  const inv = auditarInvariantes(root, arquivos);

  const precondicoes = [];
  if (adr.descobertas === 0) {
    precondicoes.push("precondicao: nenhuma referencia de ADR encontrada — nada a validar");
  }
  if (inv.precondicao) precondicoes.push(`precondicao: ${inv.precondicao}`);
  if (precondicoes.length > 0) return { exit: EXIT_PRECONDICAO, mensagens: precondicoes };

  const violacoes = [];
  for (const morta of adr.mortas) {
    violacoes.push(
      `referencia de ADR morta: ${morta.alvo} (citada em ${morta.arquivo}:${morta.linha})`,
    );
  }
  for (const item of inv.fora) {
    violacoes.push(
      `invariante fora do registro: ${item.id} (citada em ${item.arquivo}:${item.linha})`,
    );
  }
  if (violacoes.length > 0) return { exit: EXIT_VIOLACAO, mensagens: violacoes };

  return {
    exit: EXIT_OK,
    mensagens: [
      `sdd-drift: OK — ${adr.descobertas} referencia(s) de ADR resolvem; ` +
        `${inv.citados.length}/${inv.declarados.length} invariante(s) citada(s) constam no registro`,
    ],
  };
}

function exists(caminho) {
  return statSync(caminho, { throwIfNoEntry: false })?.isFile() === true;
}

function main() {
  const rootArg = process.argv.indexOf("--root");
  const root = resolve(
    rootArg >= 0 ? process.argv[rootArg + 1] : dirname(dirname(fileURLToPath(import.meta.url))),
  );
  try {
    const resultado = auditar(root);
    for (const mensagem of resultado.mensagens) console.error(mensagem);
    process.exit(resultado.exit);
  } catch (error) {
    console.error(
      `precondicao: falha ao ler a arvore — ${error instanceof Error ? error.message : error}`,
    );
    process.exit(EXIT_PRECONDICAO);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
