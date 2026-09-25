# Inventário de fórmulas M-02

| Local atual                                         | Fórmula/cálculo                                        | Destino canônico                           | Estado          |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ | --------------- |
| `src/routes/_authenticated/diagnostico.tsx`         | custo, margem, break-even, formação de preço e alertas | `DiagnosticService`/read model server-side | migração        |
| `src/routes/_authenticated/despesas.tsx`            | soma de despesas fixas/variáveis                       | `ExpenseService.totals`                    | migração        |
| `src/routes/_authenticated/simulacoes.tsx`          | composição do input what-if                            | módulo puro compartilhado + BFF            | adapter         |
| `src/routes/_authenticated/ponto-equilibrio.tsx`    | adaptação de DTO                                       | `BreakEvenService`                         | preservar       |
| `src/server/services/product-read-model.service.ts` | projeção financeira de produto                         | motor decimal canônico                     | consolidar      |
| `src/lib/finance.ts`                                | motor financeiro legado numérico                       | adapter/paridade e posterior remoção       | compatibilidade |

Thresholds de alertas devem sair da rota e receber `rulesVersion`.
