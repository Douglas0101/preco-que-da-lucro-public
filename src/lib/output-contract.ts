/**
 * Contrato de saída das server functions do BFF (DBT-25, plano §6.1).
 *
 * Existe por causa de um vazio medido, não por especulação: as 35 server
 * functions de `src/lib/*.functions.ts` validavam a **entrada** e nenhuma
 * validava a **saída**. O tipo TypeScript de retorno não é verificado em runtime
 * — trocar o serviço, o mapeador ou o driver muda o que sai da fronteira sem
 * que nada no repositório perceba.
 *
 * `outputSchema` é o **mecanismo**, e nenhum schema mora aqui: o contrato de
 * cada função é um schema Zod declarado **inline, no arquivo da própria server
 * function**, como manda [`CONTRACT-POLICY.md`](../../docs/upgrades/CONTRACT-POLICY.md).
 * Um diretório paralelo de contratos (`src/server/bff/contracts/`) é proibido
 * pelo `AGENTS.md`: duas convenções divergem sozinhas.
 *
 * Canal de falha: o repo **não** devolve envelope de erro do handler, ele lança.
 * `ApplicationError("DEPENDENCY_ERROR")` é capturado por `requireDatabaseAuth`
 * (`src/middleware/request-context.ts`), que mapeia o código para a resposta 503
 * do §6.9 e registra `bff.request_failed`. **INV-013:** falha de parse nunca vira
 * lista vazia nem `null` — o sucesso vazio é exatamente o defeito que este
 * contrato existe para tornar impossível.
 *
 * Limite declarado: o schema **não** é `.strict()`. Chave desconhecida é
 * removida (comportamento padrão do Zod), não reprovada: derrubar uma resposta
 * legítima por um campo a mais seria trocar um defeito silencioso por uma
 * indisponibilidade de 503 no caminho do dinheiro.
 */
import type { z } from "zod";
import { ApplicationError } from "@/lib/api-error";
import { logJson } from "@/lib/structured-logger";

/**
 * Valida o valor que o handler devolve contra o schema de saída da função.
 *
 * @param schema  contrato de saída, declarado no arquivo da própria função.
 * @param subject identificador estável para log (`arquivo.função`).
 * @param value   o valor cru que o handler ia devolver.
 * @returns o valor **parseado** (transformações do schema aplicadas).
 * @throws ApplicationError `DEPENDENCY_ERROR` — nunca devolve vazio no lugar do erro.
 */
export function outputSchema<S extends z.ZodType>(
  schema: S,
  subject: string,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    logJson("error", "bff.output_contract_violation", {
      subject,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
    throw new ApplicationError("DEPENDENCY_ERROR", {
      message: `Contrato de saída violado em ${subject}.`,
      cause: parsed.error,
    });
  }
  return parsed.data;
}
