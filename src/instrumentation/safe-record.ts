import type { Attributes } from "@opentelemetry/api";

/** Subconjunto de instrumento OTel que este guard cobra: só `record`. */
export interface RecordableMetric {
  record(value: number, attributes?: Attributes): void;
}

/**
 * Registro de métrica que nunca quebra o caminho da request — a mesma regra
 * defensiva dos observables do pool em `telemetry.ts` e a correção sistêmica do
 * §19.3: um `record` que lance não pode rejeitar uma operação já concluída,
 * substituir o erro real (inclusive dentro de `finally`/tratamento de erro) nem
 * pular o callback do usuário. Nenhum call site precisa lembrar da regra.
 *
 * Os argumentos são encaminhados exatamente como recebidos — `[value]` continua
 * uma chamada de um argumento só — para que a série exportada seja idêntica à
 * de um `record` direto.
 */
export function recordSafely(
  metric: RecordableMetric,
  ...measurement: [value: number, attributes?: Attributes]
): void {
  try {
    metric.record(...measurement);
  } catch {
    // Observabilidade nunca quebra o caminho da request.
  }
}
