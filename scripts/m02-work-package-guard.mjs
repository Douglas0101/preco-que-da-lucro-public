#!/usr/bin/env node
// Guard do contrato de work package (docs/evidence/_templates/work-package.md).
//
// Valida a ESTRUTURA do template: secoes obrigatorias, checklist anti-vacuoso com
// 17 itens numerados, coluna de origem identificada pelo header (nao "a ultima
// coluna") e com conteudo rastreavel (nao degenerado), taxonomia CORR x N e o
// layout do selo. Nao valida prosa nem conteudo de um WP especifico — o
// enforcement de conteudo e humano/S6 (vide o proprio template).
//
// Node built-ins apenas (os dois pipelines rodam este guard sem instalar deps).
// Uso: node scripts/m02-work-package-guard.mjs [--template <caminho>]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_TEMPLATE = "docs/evidence/_templates/work-package.md";
const EXPECTED_ITEMS = 17;
const EXPECTED_CHECKLIST_COLUMNS = 4;
const ORIGIN_HEADER = /^origem\b/i;
const DEGENERATE_ORIGIN = /^(n\/?a|tbd|\?+|—|-+|\.+)$/i;
const DEMO_HEADER = /^como demonstrar\b/i;
const DEGENERATE_DEMO = /^(n\/?a|tbd|\?+|—|-+|\.+)$/i;
// Piso de nao-vacuidade da coluna de demonstracao (S6 N4 do WP-R5): a celula mais curta do
// template real tem 84 caracteres e a mediana 121; 40 fica muito abaixo do menor caso legitimo e
// muito acima de um preenchimento de fachada. E um piso, nao um juizo semantico — vacuidade de
// conteudo continua sendo objeto do S6.
const MIN_DEMO_LENGTH = 40;
const REQUIRED_SECTIONS = [
  "## 1. Seções obrigatórias do SPEC",
  "## 2. Seções obrigatórias do README",
  "## 3. Checklist anti-vacuoso",
  "## 4. Taxonomia de veredicto",
  "## Apêndice B — layout do selo",
];

function parseArgs(argv) {
  const index = argv.indexOf("--template");
  if (index === -1) return { template: DEFAULT_TEMPLATE };
  const value = argv[index + 1];
  if (!value) throw new Error("--template exige um caminho");
  return { template: value };
}

function cells(linha) {
  return linha
    .split("|")
    .slice(1, -1)
    .map((celula) => celula.trim());
}

function fail(mensagens) {
  for (const mensagem of mensagens) console.error(`work-package guard: ${mensagem}`);
  console.error(`work-package guard: REPROVADO (${mensagens.length} falha(s))`);
  process.exitCode = 1;
}

function validarChecklist(secao, falhas) {
  const linhas = secao.split("\n");
  const header = linhas.find((linha) => /^\|\s*#\s*\|/.test(linha));
  if (!header) {
    falhas.push("checklist sem linha de cabecalho (| # | ...)");
    return;
  }
  const colunas = cells(header);
  if (colunas.length !== EXPECTED_CHECKLIST_COLUMNS) {
    falhas.push(
      `cabecalho do checklist tem ${colunas.length} colunas; esperado ${EXPECTED_CHECKLIST_COLUMNS}`,
    );
  }
  const origemIndex = colunas.findIndex((coluna) => ORIGIN_HEADER.test(coluna));
  if (origemIndex === -1) {
    falhas.push("checklist sem coluna de origem (header 'origem ...')");
    return;
  }
  const demoIndex = colunas.findIndex((coluna) => DEMO_HEADER.test(coluna));
  if (demoIndex === -1) {
    falhas.push("checklist sem coluna de demonstracao (header 'como demonstrar')");
    return;
  }

  const itens = [];
  for (const linha of linhas) {
    const m = /^\|\s*(\d+)\s*\|/.exec(linha);
    if (!m) continue;
    itens.push({ numero: Number(m[1]), celulas: cells(linha) });
  }
  if (itens.length !== EXPECTED_ITEMS) {
    falhas.push(`checklist tem ${itens.length} itens; esperado ${EXPECTED_ITEMS}`);
  }
  itens.forEach((item, index) => {
    if (item.numero !== index + 1) {
      falhas.push(`item fora de sequencia: ${item.numero} na posicao ${index + 1}`);
    }
    if (item.celulas.length !== EXPECTED_CHECKLIST_COLUMNS) {
      falhas.push(
        `item ${item.numero} tem ${item.celulas.length} colunas; esperado ${EXPECTED_CHECKLIST_COLUMNS}`,
      );
      return;
    }
    const corpo = item.celulas[1] ?? "";
    if (corpo.length === 0) falhas.push(`item ${item.numero} sem descricao`);
    const demonstracao = item.celulas[demoIndex] ?? "";
    if (demonstracao.length < MIN_DEMO_LENGTH || DEGENERATE_DEMO.test(demonstracao)) {
      falhas.push(
        `item ${item.numero} com demonstracao degenerada ou vazia (${demonstracao.length} < ${MIN_DEMO_LENGTH}): "${demonstracao.slice(0, 60)}"`,
      );
    }
    const origem = item.celulas[origemIndex] ?? "";
    if (origem.length < 4 || DEGENERATE_ORIGIN.test(origem)) {
      falhas.push(`item ${item.numero} com origem degenerada ou vazia: "${origem}"`);
    }
  });
}

function main() {
  const { template } = parseArgs(process.argv.slice(2));
  const caminho = resolve(process.cwd(), template);

  let texto;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch (error) {
    fail([`template ilegivel em ${template}: ${error.message}`]);
    return;
  }

  const falhas = [];

  for (const secao of REQUIRED_SECTIONS) {
    if (!texto.includes(secao)) falhas.push(`secao ausente: ${secao}`);
  }

  const inicio = texto.indexOf("## 3. Checklist anti-vacuoso");
  const fim = texto.indexOf("## 4. Taxonomia de veredicto");
  if (inicio === -1 || fim === -1 || fim <= inicio) {
    falhas.push("nao foi possivel delimitar a secao do checklist");
  } else {
    validarChecklist(texto.slice(inicio, fim), falhas);
  }

  for (const ancora of ["**CORR**", "**N** =", '"Correções forçadas"']) {
    if (!texto.includes(ancora)) falhas.push(`taxonomia sem a ancora ${ancora}`);
  }

  if (!texto.includes("Auto-verificação pré-S6")) {
    falhas.push("template sem o campo de auto-verificacao pre-S6 (KPI do checklist)");
  }

  for (const componente of ["SPEC.md", "README.md", "MANIFEST.sha256", "captures/"]) {
    if (!texto.includes(componente)) falhas.push(`layout do selo sem ${componente}`);
  }

  if (falhas.length > 0) {
    fail(falhas);
    return;
  }
  console.log(
    `work-package guard: OK (${EXPECTED_ITEMS} itens, ${REQUIRED_SECTIONS.length} secoes, taxonomia e layout do selo) — ${template}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`work-package guard: ERRO ${error.message}`);
  process.exitCode = 2;
}
