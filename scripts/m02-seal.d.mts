// GERADO por scripts/generate-seal-dts.mjs a partir de scripts/m02-seal.mjs — nao edite a mao.
// A fonte dos tipos e o JSDoc do modulo; `node scripts/generate-seal-dts.mjs --check` reprova
// qualquer divergencia (DBT-16).
/** @param {string | Uint8Array} contents @returns {string} */
export function sha256(contents: string | Uint8Array): string;
/** @param {string[]} argv @returns {SealArgs} */
export function parseArgs(argv: string[]): SealArgs;
/** @param {string} dir @returns {{ files: string[], problemas: string[] }} */
export function scanSelo(dir: string): {
  files: string[];
  problemas: string[];
};
/** @param {string} dir @returns {string[]} */
export function discoverFiles(dir: string): string[];
/** @param {string} text @returns {{ entries: Map<string, string>, falhas: string[] }} */
export function parseManifest(text: string): {
  entries: Map<string, string>;
  falhas: string[];
};
/**
 * @param {{ discovered: string[], hashes: Map<string, string>, manifestText: string, required?: string[] }} input
 * @returns {string[]}
 */
export function auditManifest({
  discovered,
  hashes,
  manifestText,
  required,
}: {
  discovered: string[];
  hashes: Map<string, string>;
  manifestText: string;
  required?: string[];
}): string[];
/** @param {string} text @returns {SealClaim[]} */
export function extractAncestryClaims(text: string): SealClaim[];
/** @param {string} text @returns {number} */
export function countAncestryMentions(text: string): number;
/**
 * @param {string} text
 * @param {{ runAncestor: (ancestor: string, descendant: string) => number }} opts
 * @returns {string[]}
 */
export function auditAncestry(
  text: string,
  {
    runAncestor,
  }: {
    runAncestor: (ancestor: string, descendant: string) => number;
  },
): string[];
/** @param {SealRun} run @returns {number} */
export function countApplicableSteps(run: SealRun): number;
/**
 * @param {SealRun | null} run
 * @param {{ commit: string, isAncestor: (ancestor: string, descendant: string) => boolean }} opts
 * @returns {string[]}
 */
export function auditRun(
  run: SealRun | null,
  {
    commit,
    isAncestor,
  }: {
    commit: string;
    isAncestor: (ancestor: string, descendant: string) => boolean;
  },
): string[];
/**
 * Caminhos de `git status --porcelain -z`: entradas NUL-separadas no formato `XY caminho`.
 * `-z` **nao cita** caminhos (ao contrario do porcelain textual, que emite `"caf\303\251.txt"`)
 * e, em rename/copia, emite o caminho novo nesta entrada e o antigo no campo seguinte.
 */
/** @param {string} text @returns {string[]} */
export function parseStatusZ(text: string): string[];
/**
 * Precondicao de estado ambiente: nada derivado **fora** do proprio diretorio do selo.
 * O selo descobre por filesystem, entao um `.gitignore` derivado no worktree nao aparece em CI
 * e contamina a medicao local — e exatamente o que este check recusa.
 */
/** @param {{ porcelain: string, dir: string }} input @returns {string[]} */
export function driftForaDoSelo({ porcelain, dir }: { porcelain: string; dir: string }): string[];
/**
 * Falha de **precondicao** (nao determinavel), distinta de veredito: nunca vira "nao e ancestral".
 * O selo sai com exit 2 e mensagem nomeada; exit 1 fica reservado a relacao provada falsa.
 */
export class PreconditionError extends Error {
  constructor(message: any);
}
export type SealClaim = {
  ancestor: string;
  descendant: string;
};
export type SealRun = {
  databaseId?: number;
  headSha?: string;
  conclusion?: string;
  jobs?: Array<{
    steps?: Array<{
      name?: string;
      conclusion?: string;
    }>;
  }>;
};
export type SealArgs = {
  dir?: string;
  write?: boolean;
  ancestry?: string;
  run?: string;
  error?: string;
};
/** @type {string} */
export const MANIFEST: string;
/**
 * @typedef {Object} SealClaim
 * @property {string} ancestor
 * @property {string} descendant
 */
/**
 * @typedef {Object} SealRun
 * @property {number} [databaseId]
 * @property {string} [headSha]
 * @property {string} [conclusion]
 * @property {Array<{ steps?: Array<{ name?: string, conclusion?: string }> }>} [jobs]
 */
/**
 * @typedef {Object} SealArgs
 * @property {string} [dir]
 * @property {boolean} [write]
 * @property {string} [ancestry]
 * @property {string} [run]
 * @property {string} [error]
 */
export const REQUIRED_FILES: string[];
