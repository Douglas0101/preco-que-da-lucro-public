#!/usr/bin/env node
// Guard do registry de dividas (docs/evidence/agent-state/DEBTS.md).
//
// Valida a ESTRUTURA do registry: colunas obrigatorias lidas pelo header (nao
// pela posicao), valores nao degenerados, taxonomia de classe/severidade/status
// e a regra "sem closure test => status NS" nas duas direcoes. Nao julga o
// merito da divida — isso e humano/S6 (vide o template de work package).
//
// Node built-ins apenas (os tres pipelines rodam este guard sem instalar deps).
// Uso: node scripts/m02-debts-guard.mjs [--registry <caminho>]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_REGISTRY = "docs/evidence/agent-state/DEBTS.md";
const REQUIRED_COLUMNS = [
  "id",
  "origem",
  "classe",
  "severidade",
  "closure test",
  "evidencia",
  "status",
];
const CLASSES = new Set(["conformidade", "robustez", "higiene"]);
const SEVERITIES = new Set(["alta", "media", "baixa"]);
const STATUSES = new Set(["ABERTA", "EM_TRATAMENTO", "FECHADA", "NS"]);
const DEGENERATE = /^(n\/?a|tbd|\?+|—|-+|\.+)$/i;
const ID_PATTERN = /^DBT-\d{2}$/;

function normalize(value) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function parseArgs(argv) {
  const index = argv.indexOf("--registry");
  if (index === -1) return { registry: DEFAULT_REGISTRY };
  const value = argv[index + 1];
  if (!value) throw new Error("--registry exige um caminho");
  return { registry: value };
}

function cells(linha) {
  return linha
    .split("|")
    .slice(1, -1)
    .map((celula) => celula.trim());
}

function isSeparator(linha) {
  const celulas = cells(linha);
  return celulas.length > 0 && celulas.every((celula) => /^:?-+:?$/.test(celula));
}

function fail(mensagens) {
  for (const mensagem of mensagens) console.error(`debts guard: ${mensagem}`);
  console.error(`debts guard: REPROVADO (${mensagens.length} falha(s))`);
  process.exitCode = 1;
}

function validarRegistry(texto, falhas) {
  const linhas = texto.split("\n");
  const candidatos = [];
  for (let i = 0; i < linhas.length; i += 1) {
    if (!linhas[i].trim().startsWith("|")) continue;
    const colunas = cells(linhas[i]).map(normalize);
    if (colunas.includes("id") && colunas.includes("origem")) candidatos.push(i);
  }
  if (candidatos.length === 0) {
    falhas.push("registry sem linha de cabecalho (| id | ... | origem | ...)");
    return 0;
  }
  if (candidatos.length > 1) {
    falhas.push(
      `registry tem mais de uma tabela canonica (linhas ${candidatos.map((i) => i + 1).join(", ")})`,
    );
    return 0;
  }
  const headerIndex = candidatos[0];
  const colunas = cells(linhas[headerIndex]).map(normalize);
  const indices = {};
  for (const coluna of REQUIRED_COLUMNS) {
    indices[coluna] = colunas.indexOf(coluna);
    if (indices[coluna] === -1) falhas.push(`registry sem a coluna obrigatoria "${coluna}"`);
  }
  if (Object.values(indices).includes(-1)) return 0;

  const ids = new Set();
  let dividas = 0;
  let i = headerIndex + 1;
  if (isSeparator(linhas[i] ?? "")) i += 1;
  for (; i < linhas.length && linhas[i].trim().startsWith("|"); i += 1) {
    const celulas = cells(linhas[i]);
    if (celulas.every((celula) => celula.length === 0)) continue;
    dividas += 1;
    const id = celulas[indices.id] ?? "";
    if (!ID_PATTERN.test(id)) {
      falhas.push(`linha com id fora do padrao DBT-NN: "${id}"`);
      continue;
    }
    if (ids.has(id)) falhas.push(`id duplicado: ${id}`);
    ids.add(id);
    if (celulas.length !== colunas.length) {
      falhas.push(`divida ${id} tem ${celulas.length} celulas; o cabecalho tem ${colunas.length}`);
      continue;
    }
    for (const coluna of ["origem", "evidencia", "classe", "severidade", "status"]) {
      const valor = celulas[indices[coluna]] ?? "";
      const minimo = coluna === "origem" ? 4 : 1;
      if (valor.length < minimo || DEGENERATE.test(valor)) {
        falhas.push(`divida ${id} com ${coluna} degenerada ou vazia: "${valor}"`);
      }
    }
    const classe = normalize(celulas[indices.classe] ?? "");
    if (classe && !CLASSES.has(classe)) {
      falhas.push(`divida ${id} com classe fora da taxonomia: "${celulas[indices.classe]}"`);
    }
    const severidade = normalize(celulas[indices.severidade] ?? "");
    if (severidade && !SEVERITIES.has(severidade)) {
      falhas.push(
        `divida ${id} com severidade fora da taxonomia: "${celulas[indices.severidade]}"`,
      );
    }
    const status = celulas[indices.status] ?? "";
    if (status && !STATUSES.has(status)) {
      falhas.push(`divida ${id} com status fora da taxonomia: "${status}"`);
    }
    const closure = celulas[indices["closure test"]] ?? "";
    const temClosure = closure.length > 0 && !DEGENERATE.test(closure);
    if (temClosure && status === "NS") {
      falhas.push(`divida ${id} com closure test presente e status NS (nao contavel)`);
    }
    if (!temClosure && status !== "NS") {
      falhas.push(`divida ${id} sem closure test exige status NS (recebido "${status}")`);
    }
  }
  if (dividas === 0) falhas.push("registry vazio: nenhuma divida declarada (0 = 0 reprova)");
  return dividas;
}

function main() {
  const { registry } = parseArgs(process.argv.slice(2));
  const caminho = resolve(process.cwd(), registry);

  let texto;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch (error) {
    console.error(`debts guard: registry ilegivel em ${registry}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const falhas = [];
  const dividas = validarRegistry(texto, falhas);
  if (falhas.length > 0) {
    fail(falhas);
    return;
  }
  console.log(`debts guard: OK (${dividas} dividas, taxonomia e regra de closure) — ${registry}`);
}

try {
  main();
} catch (error) {
  console.error(`debts guard: ERRO ${error.message}`);
  process.exitCode = 2;
}
