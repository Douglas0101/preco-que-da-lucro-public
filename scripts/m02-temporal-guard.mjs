#!/usr/bin/env node
// Guarda temporal das âncoras em prosa (análise de 2026-09-21 §6.2).
//
// PROBLEMA: o programa escreve SHAs e prazos em prosa (journal, ledger, fila humana) e os dois
// envelhecem em silêncio — `L141` registra um prazo de watcher 5 dias velho e `L131` um `run@sha`
// que apontava para o commit ANTERIOR ao WP que ele dizia cobrir. Nada reprovava.
//
// SUPERFÍCIE VIVA (declarada, recortada por parsing — nunca por lista de afirmações):
//   - §1 do `docs/evidence/agent-state/PROGRESS.md`;
//   - último bloco `###` do `EXECUTION-STATE-PROGRAM.md`;
//   - `REGISTRO-H.md` MENOS a seção `## Fechados` (a fila aberta E o que vem depois dela).
// O journal append-only fica fora: linha histórica com prazo vencido é registro do que era verdade
// então. LIMITE DECLARADO (S6 D2): as intenções órfãs (`▶` sem `✔`/`✘`) vivem no journal e são
// estado vivo pelo protocolo de escrita; elas NÃO são cobertas por esta guarda.
//
// INVARIANTES (endurecidas pelo S6 do WP-R7 — 13 defeitos novos):
//   T1 PRAZO  — data VÁLIDA (`AAAA-MM-DD`, mês/dia com 1 ou 2 dígitos) que venha ATÉ 100 caracteres
//               DEPOIS de um VERBO de prazo com fronteira (`\bcaduca\b`, `\bexpira\b`, `\bvence\b`,
//               `\bdeadline\b`) tem de estar no futuro; data inválida (rollover) e data no passado
//               reprovam. O substantivo "prazo" NAO e marcador — e palavra-tema ("Prazo:", "o prazo
//               anterior") e incluí-lo reprovava a data de re-arme do watcher. A isencao de errata e
//               POR DATA (janela de ±45 caracteres com `ERRATA|histórico|anterior|desatualizad|
//               corrigid`), nao por linha: a linha do `REGISTRO-H` carrega o prazo vivo e a errata
//               juntas, e isentar a linha esconderia a afirmacao viva.
//   T2 ÂNCORA — token em crases que seja (a) hex de 7–40 COM ao menos uma letra, ou (b) par
//               `sha@run` com o sha à esquerda, tem de RESOLVER. Sufixo `…` (U+2026) ou `...` é
//               prefixo; a resolução aceita QUALQUER objeto (commit, árvore, blob), porque a
//               convenção do repo carimba ÁRVORE. Token todo-decimal é id de run, não âncora.
//
// Exit: 0 tudo confere · 1 violação (nomeada) · 2 precondição (sem git, superfície ausente, recorte
// vazio, cabeçalho de fronteira ausente). Node built-ins apenas.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SUPERFICIE = [
  { arquivo: "docs/evidence/agent-state/PROGRESS.md", recorte: "secao-1" },
  { arquivo: "EXECUTION-STATE-PROGRAM.md", recorte: "ultimo-bloco" },
  {
    arquivo: "docs/evidence/agent-state/DECISIONS-PENDING/REGISTRO-H.md",
    recorte: "fora-do-fechado",
  },
];

const PRAZO = /\b(caduca|caducidade|expira|vence|deadline)\b/gi;
const DATA = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?Z?)?/g;
const HISTORICO =
  /\b(ERRATA|errata|hist[oó]rico|hist[oó]rica|anterior|anteriormente|desatualizad\w*|corrigid\w*)\b/;
// (a) hex de 7-40 com pelo menos uma letra; (b) `sha@run` com o sha a esquerda.
const HEX_COM_LETRA = "(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}";
const ANCORA = new RegExp(
  `\`(${HEX_COM_LETRA})(?:…|\\.\\.\\.)?\`|\`(${HEX_COM_LETRA})@(\\d{4,})\``,
  "g",
);

/**
 * @param {string} texto
 * @param {"secao-1" | "ultimo-bloco" | "fora-do-fechado"} recorte
 * @returns {{ trecho: string, fronteira: boolean }}
 */
export function recortar(texto, recorte) {
  const linhas = texto.split("\n");
  if (recorte === "secao-1") {
    const i = linhas.findIndex((l) => /^##\s+1\./.test(l));
    if (i === -1) return { trecho: "", fronteira: false };
    const j = linhas.findIndex((l, k) => k > i && /^##\s/.test(l));
    return { trecho: linhas.slice(i, j === -1 ? linhas.length : j).join("\n"), fronteira: true };
  }
  if (recorte === "ultimo-bloco") {
    const inicio = linhas.map((l, k) => (/^###\s/.test(l) ? k : -1)).filter((k) => k !== -1);
    if (inicio.length === 0) return { trecho: "", fronteira: false };
    return { trecho: linhas.slice(inicio[inicio.length - 1]).join("\n"), fronteira: true };
  }
  // `fora-do-fechado`: remove a secao `## Fechados` e mantem o resto (fila aberta E o que vem
  // depois dela). A fronteira e ASSERTADA: sem ela o recorte degradaria para o arquivo inteiro em
  // silencio e a guarda passaria a reprovar historia (S6 N7).
  const i = linhas.findIndex((l) => /^##\s+Fechados/.test(l));
  if (i === -1) return { trecho: "", fronteira: false };
  const j = linhas.findIndex((l, k) => k > i && /^##\s/.test(l));
  const mantidas = [...linhas.slice(0, i), ...linhas.slice(j === -1 ? linhas.length : j)];
  return { trecho: mantidas.join("\n"), fronteira: true };
}

/**
 * @param {string} texto
 * @param {Date} asOf
 * @returns {string[]} falhas nomeadas
 */
export function auditarPrazos(texto, asOf) {
  const falhas = [];
  texto.split("\n").forEach((linha, idx) => {
    const marcas = [...linha.matchAll(PRAZO)];
    if (marcas.length === 0) return;
    for (const d of linha.matchAll(DATA)) {
      // So e prazo a data que vem DEPOIS de um VERBO de prazo, a <=100 caracteres dele. O
      // substantivo "prazo" e palavra-tema ("Prazo:", "o prazo anterior") e por isso NAO e marcador:
      // a primeira versao o incluia e reprovava a data de re-arme do watcher como prazo vencido.
      const antes = marcas.filter((m) => m.index < d.index && d.index - m.index <= 100);
      if (antes.length === 0) continue;
      // Isencao POR DATA, nao por linha (S6 N1/A3): a linha do `REGISTRO-H` carrega o prazo VIVO e a
      // errata historica juntas. Isentar a linha inteira esconderia a afirmacao viva; isentar so a
      // data marcada como historica mantem a vigilia e nao pune a pratica de errata que o repo manda.
      const janela = linha.slice(Math.max(0, d.index - 45), d.index + d[0].length + 45);
      if (HISTORICO.test(janela)) continue;
      const [, ano, mes, dia, hh, mm, ss] = d;
      const Y = Number(ano);
      const M = Number(mes);
      const D = Number(dia);
      const valida = M >= 1 && M <= 12 && D >= 1 && D <= new Date(Date.UTC(Y, M, 0)).getUTCDate();
      if (!valida) {
        falhas.push(
          `T1 data INVALIDA ${ano}-${mes}-${dia} (linha ${idx + 1}): ${linha.trim().slice(0, 120)}`,
        );
        continue;
      }
      const quando = Date.UTC(Y, M - 1, D, Number(hh ?? 23), Number(mm ?? 59), Number(ss ?? 59));
      if (quando < asOf.getTime()) {
        const data = `${ano}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
        falhas.push(
          `T1 prazo vencido em ${data}${hh ? `T${hh}:${mm}Z` : ""} (linha ${idx + 1}): ${linha.trim().slice(0, 120)}`,
        );
      }
    }
  });
  return falhas;
}

/**
 * @param {string} texto
 * @param {(token: string, prefixo: boolean) => boolean} resolve
 * @returns {string[]}
 */
export function auditarAncoras(texto, resolve) {
  const falhas = [];
  texto.split("\n").forEach((linha, idx) => {
    for (const m of linha.matchAll(ANCORA)) {
      const token = m[1] ?? m[2];
      const truncado = m[1] !== undefined && /(?:…|\.\.\.)`$/.test(m[0]);
      if (!resolve(token, truncado)) {
        falhas.push(
          `T2 âncora não resolve: \`${token}${truncado ? "…" : ""}\` (linha ${idx + 1}): ${linha.trim().slice(0, 120)}`,
        );
      }
    }
  });
  return falhas;
}

/**
 * @param {string} root
 * @returns {(token: string, prefixo: boolean) => boolean}
 */
export function resolvedorGit(root) {
  const cache = new Map();
  return (token, prefixo) => {
    const chave = `${token}|${prefixo}`; // S6 N4: ignorar `prefixo` invertia vereditos por ordem
    if (cache.has(chave)) return cache.get(chave);
    // aceita QUALQUER objeto: a convencao do repo carimba ARVORE, nao commit (S6 N5)
    const r = prefixo
      ? spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${token}^{object}`], {
          encoding: "utf8",
        })
      : spawnSync("git", ["-C", root, "cat-file", "-e", token], { encoding: "utf8" });
    const ok = r.status === 0;
    cache.set(chave, ok);
    return ok;
  };
}

/**
 * @param {string} root
 * @param {Date} asOf
 * @returns {{ falhas: string[], auditados: number }}
 */
export function auditar(root, asOf) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--git-dir"], { encoding: "utf8" });
  if (r.status !== 0) {
    const erro = new Error(`precondicao: ${root} nao e um repositorio git`);
    erro.precondicao = true;
    throw erro;
  }
  // Precondicao de AMBIENTE (item 17): num clone raso as ancoras citadas em prosa nao existem no
  // repositorio local e a guarda acusaria "nao resolve" quando a causa e o clone. A pesada ficou
  // vermelha em `4c2e35d` por isso; agora o modo de falha e NOMEADO e a correcao e `fetch-depth: 0`.
  const raso = spawnSync("git", ["-C", root, "rev-parse", "--is-shallow-repository"], {
    encoding: "utf8",
  });
  if ((raso.stdout ?? "").trim() === "true") {
    const erro = new Error(
      "precondicao: clone raso — as ancoras de prosa nao sao resolviveis aqui (use fetch-depth: 0)",
    );
    erro.precondicao = true;
    throw erro;
  }
  const resolveGit = resolvedorGit(root);
  const falhas = [];
  let auditados = 0;
  for (const { arquivo, recorte } of SUPERFICIE) {
    const caminho = resolve(root, arquivo);
    if (!existsSync(caminho)) {
      const erro = new Error(`precondicao: superficie viva ausente: ${arquivo}`);
      erro.precondicao = true;
      throw erro;
    }
    const { trecho, fronteira } = recortar(readFileSync(caminho, "utf8"), recorte);
    if (!trecho.trim()) {
      const erro = new Error(`precondicao: recorte vazio em ${arquivo} (${recorte})`);
      erro.precondicao = true;
      throw erro;
    }
    if (!fronteira) {
      const erro = new Error(
        `precondicao: cabecalho de fronteira ausente em ${arquivo} (${recorte})`,
      );
      erro.precondicao = true;
      throw erro;
    }
    auditados += 1;
    const ancoras = [...trecho.matchAll(ANCORA)].length;
    const prazos = trecho
      .split("\n")
      .filter((l) => /\b(caduca|caducidade|expira|vence|deadline)\b/i.test(l)).length;
    console.log(
      `  ${arquivo} [${recorte}] — ${ancoras} âncora(s), ${prazos} linha(s) com prazo vivo`,
    );
    falhas.push(...auditarPrazos(trecho, asOf), ...auditarAncoras(trecho, resolveGit));
  }
  return { falhas, auditados };
}

const invocadoDiretamente =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invocadoDiretamente) {
  const iAsOf = process.argv.indexOf("--as-of");
  const asOf = iAsOf === -1 ? new Date() : new Date(`${process.argv[iAsOf + 1]}T00:00:00Z`);
  if (Number.isNaN(asOf.getTime())) {
    console.error("m02-temporal-guard: --as-of exige uma data YYYY-MM-DD");
    process.exit(2);
  }
  const iRoot = process.argv.indexOf("--root");
  const root = iRoot === -1 ? process.cwd() : resolve(process.argv[iRoot + 1]);
  try {
    console.log(`m02-temporal-guard: superficie viva, as-of ${asOf.toISOString().slice(0, 10)}`);
    const { falhas, auditados } = auditar(root, asOf);
    if (falhas.length > 0) {
      for (const f of falhas) console.error(`  ${f}`);
      console.error(
        `m02-temporal-guard: ${falhas.length} ancoras/prazos invalidos em ${auditados} superficies`,
      );
      process.exit(1);
    }
    console.log(`m02-temporal-guard: OK (${auditados} superficies vivas, 0 violacao)`);
  } catch (erro) {
    console.error(`m02-temporal-guard: ${erro.message}`);
    process.exit(2);
  }
}
