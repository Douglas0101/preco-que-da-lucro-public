/**
 * Classificador de "modulo de banco" da matriz M-02 (`directDatabaseFiles`).
 *
 * Vive em `scripts/lib/` por dois motivos: e puro (testavel isolado, sem importar
 * `m02-matrix.ts`, que varre o repositorio inteiro) e separa a **regra** do **contador**.
 *
 * Historico da regra (WP-R6): a versao anterior era `/\.\.?\/.*db.*$/`, que casa qualquer caminho
 * **contendo** "db" — um helper puro como `./helpers/db-precondition` (parsing de URL, zero banco)
 * era contado como arquivo de banco e reprovava `npm run check` ate regenerar a matriz. A
 * semantica pretendida sempre foi o **segmento de diretorio** `db`.
 */

/** Importa o driver, o diretorio `@/db/`, ou um caminho relativo cujo diretorio e `db`. */
export const isDatabaseModule = (moduleName: string): boolean =>
  /^(?:drizzle-orm(?:\/.*)?|@\/db\/.*|\.\.?\/(?:.*\/)?db(?:\/.*)?)$/.test(moduleName);
