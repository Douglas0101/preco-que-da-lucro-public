import { metrics } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

/**
 * Sem provider, `@opentelemetry/api` devolve o mesmo histograma noop para
 * todos os nomes — espiões de `record` ficariam indistinguíveis. Registrar um
 * MeterProvider real (sem readers: nada é exportado) antes de importar
 * `@/instrumentation/telemetry` dá uma instância por histograma.
 * Este módulo deve ser o PRIMEIRO import de quem depende dele.
 */
metrics.setGlobalMeterProvider(new MeterProvider());
