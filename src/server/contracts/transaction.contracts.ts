/**
 * §9.2 (PLANO:790-802) / M02-D-003 — unidade de trabalho **neutra de driver**.
 *
 * `RequestContext.transaction` é declarado por este tipo
 * (`src/lib/request-context.ts`), então o grafo de tipos do contexto e dos
 * contratos de repositório não alcança `@/db/client.server` nem `drizzle-orm`:
 * quem consome um contrato para tipar não herda o driver (resíduo R3 de
 * `WP-9.2R-VERDICT.md`).
 *
 * O handle real (a transação Drizzle do driver) é nomeado **apenas** no
 * adapter, que o estreita com `as DatabaseTransaction` no ponto em que executa
 * SQL. Nada de runtime nasce daqui.
 *
 * Somente-tipo: nenhum valor executável, nenhum import — o invariante é
 * enforçado por `src/test/contracts.test.ts`.
 */
export interface TransactionExecutor {
  /** Capacidade mínima que todo driver expõe e que o adapter consome depois de
   * estreitar o handle. A assinatura é deliberadamente larga: o contrato não
   * conhece os tipos de query do driver. É ela que torna a conversão do adapter
   * (`context.transaction as DatabaseTransaction`) uma asserção **verificada** —
   * se o handle concreto deixar de satisfazer esta porta, o `tsc` acusa. */
  readonly execute: (...query: never[]) => unknown;
}
