/**
 * Diagnóstico da deriva da matriz M-02.
 *
 * A comparação por STRING continua sendo o critério do gate — é ela que decide
 * exit 0/1 em `scripts/m02-matrix.ts` — e este módulo existe apenas para que a
 * falha diga *o que* mudou. Sem ele a mensagem era acionável mas não
 * diagnóstica: mandava rodar o generate e revisar o resultado, que é um diff de
 * dezenas de KB, sem nomear o contador que andou.
 *
 * Tudo aqui é PURO: recebe os dois documentos já serializados e os compara. Não
 * lê arquivo, não recalcula contador nenhum, não escreve nada, não decide exit
 * code. E o que não souber explicar, ele declara que não soube — em vez de
 * silenciar, que é o modo de falha que esta rodada inteira combate.
 *
 * DIRECAO DA MENSAGEM — os dois lados têm nomes, não "expected/actual", porque
 * esses dois rótulos são ambíguos aqui e a primeira versão deste módulo emitiu a
 * direção invertida por causa disso: um arquivo de sonda recém-criado aparecia
 * como `-` (removido). O leitor pergunta "o que eu mudei?", então a mensagem
 * responde nessa ordem: **o que está no disco -> o que a árvore diz agora**.
 */

export interface MatrixArtifact {
  /** Rótulo do arquivo na mensagem, relativo ao repositório. */
  readonly label: string;
  /** Documento que a árvore produz AGORA (o lado novo). */
  readonly fromTree: string;
  /** Documento commitado em disco (o lado velho), ou `null` se não existe. */
  readonly onDisk: string | null;
}

/** Teto de entradas listadas por lista: a mensagem não pode virar o despejo que ela combate. */
const DRIFT_LIST_LIMIT = 8;

/** Campos de lista do documento. Fora deles, o que difere é o overlay de política. */
const LIST_FIELDS = ["bffs", "routes", "transactionSites", "directDatabaseFiles"] as const;

/** Os três campos que o overlay de política acrescenta ao documento gerado. */
const OVERLAY_FIELDS = ["policy", "entryPolicies", "transactionPolicies"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseDocument(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Identidade de uma entrada de lista: a string crua, o `path` (com a linha, se houver) ou a posição. */
function identityOf(entry: unknown, index: number): string {
  if (typeof entry === "string") return entry;
  const record = asRecord(entry);
  if (typeof record.path !== "string") return `#${index}`;
  return typeof record.line === "number" ? `${record.path}:${record.line}` : record.path;
}

/** Diferença de multiconjunto: o que está em `source` e não está em `other`, contando repetições. */
function difference(source: readonly string[], other: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const id of other) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const out: string[] = [];
  for (const id of source) {
    const count = remaining.get(id) ?? 0;
    if (count > 0) {
      remaining.set(id, count - 1);
      continue;
    }
    out.push(id);
  }
  return out;
}

function describeCounts(
  fromTree: Record<string, unknown>,
  onDisk: Record<string, unknown>,
): string[] {
  const now = asRecord(fromTree.counts);
  const was = asRecord(onDisk.counts);
  const lines: string[] = [];
  for (const key of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort()) {
    const left = key in was ? String(was[key]) : "(absent)";
    const right = key in now ? String(now[key]) : "(absent)";
    if (left === right) continue;
    lines.push(`    counts.${key}: ${left} -> ${right}`);
  }
  return lines;
}

function describeLists(
  fromTree: Record<string, unknown>,
  onDisk: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const name of LIST_FIELDS) {
    const now = Array.isArray(fromTree[name]) ? (fromTree[name] as unknown[]) : null;
    const was = Array.isArray(onDisk[name]) ? (onDisk[name] as unknown[]) : null;
    if (now === null && was === null) continue;
    const treeIds = (now ?? []).map((entry, index) => identityOf(entry, index));
    const diskIds = (was ?? []).map((entry, index) => identityOf(entry, index));
    // "added" é o que a árvore ganhou, não o que o arquivo ganhou.
    const added = difference(treeIds, diskIds);
    const removed = difference(diskIds, treeIds);
    if (added.length === 0 && removed.length === 0) continue;
    lines.push(
      `    ${name}: ${diskIds.length} -> ${treeIds.length} (${added.length} added, ${removed.length} removed)`,
    );
    const details = [...added.map((id) => `+ ${id}`), ...removed.map((id) => `- ${id}`)];
    for (const detail of details.slice(0, DRIFT_LIST_LIMIT)) lines.push(`      ${detail}`);
    if (details.length > DRIFT_LIST_LIMIT) {
      lines.push(`      ... and ${details.length - DRIFT_LIST_LIMIT} more of ${details.length}`);
    }
  }
  return lines;
}

/**
 * O que sobrou depois de contadores e listas: nomeia os campos que realmente diferem.
 *
 * Nunca afirma "só o overlay" sem ter olhado. A primeira versão dizia isso **sempre** que
 * contadores e identidades de lista coincidiam, e por isso culpava a política quando o que
 * mudara era, por exemplo, um import dentro de um `bffs[]` — uma mudança de conteúdo que a
 * comparação por identidade não vê e que nada tem a ver com o overlay. Era a mesma classe de
 * "documento que mente" que este work package existe para combater.
 */
function describeResidual(
  fromTree: Record<string, unknown>,
  onDisk: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(fromTree), ...Object.keys(onDisk)]);
  const dentroDeLista: string[] = [];
  const overlay: string[] = [];
  const outros: string[] = [];
  for (const key of [...keys].sort()) {
    if (key === "counts") continue;
    if (JSON.stringify(onDisk[key]) === JSON.stringify(fromTree[key])) continue;
    if ((LIST_FIELDS as readonly string[]).includes(key)) {
      dentroDeLista.push(key);
      continue;
    }
    if ((OVERLAY_FIELDS as readonly string[]).includes(key)) {
      overlay.push(key);
      continue;
    }
    outros.push(key);
  }

  const lines: string[] = [];
  if (dentroDeLista.length > 0) {
    lines.push(
      `    the counters and the list identities are identical, but the content of ${dentroDeLista.join(
        ", ",
      )} differs`,
    );
  }
  if (outros.length > 0) {
    lines.push(
      `    the counters and the list identities are identical, but these fields differ: ${outros.join(", ")}`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      overlay.length > 0
        ? "    only the policy overlay differs (counts and lists are identical)"
        : "    the two documents differ, but not in any field the descriptor itemises",
    );
  }
  return lines;
}

/**
 * Uma linha por arquivo que derivou, nomeando o que mudou — do que está no disco
 * para o que a árvore diz agora.
 *
 * Devolve `[]` quando nada derivou — e é isso que o teste de árvore intacta
 * verifica, para que o descritor não possa "explicar" uma árvore em dia.
 */
export function describeMatrixDrift(artifacts: readonly MatrixArtifact[]): readonly string[] {
  const lines: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.onDisk === null) {
      lines.push(`  ${artifact.label}: missing (the file does not exist)`);
      continue;
    }
    if (artifact.onDisk === artifact.fromTree) continue;

    const onDisk = parseDocument(artifact.onDisk);
    const fromTree = parseDocument(artifact.fromTree);
    if (onDisk === null) {
      lines.push(`  ${artifact.label}: unreadable (invalid JSON, or not an object)`);
      continue;
    }
    if (fromTree === null) {
      lines.push(
        `  ${artifact.label}: drift detected, but the expected document is not comparable`,
      );
      continue;
    }

    lines.push(`  ${artifact.label}:`);
    const detail = [...describeCounts(fromTree, onDisk), ...describeLists(fromTree, onDisk)];
    if (detail.length === 0) {
      lines.push(...describeResidual(fromTree, onDisk));
      continue;
    }
    lines.push(...detail);
  }
  return lines;
}
