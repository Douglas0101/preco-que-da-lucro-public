import { z } from "zod";

/**
 * Versão otimista (CAS/T2): contador inteiro não-negativo mantido pelo banco.
 * Não é valor financeiro — por isso vive fora dos schemas FIN-003
 * (`DecimalStringSchema`) e centraliza o contrato de `create/update`.
 */
export const optimisticVersionSchema = z.number().int().nonnegative();
