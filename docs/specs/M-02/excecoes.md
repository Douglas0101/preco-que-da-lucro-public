# Allowlist M-02

| Categoria | Caminhos permitidos                                       | Condição                            |
| --------- | --------------------------------------------------------- | ----------------------------------- |
| health    | `src/routes/api/health/**`                                | probe operacional sem domínio       |
| auth      | `src/middleware/request-context.ts`, `src/server/auth/**` | identidade, membership e rate limit |
| infra     | `src/db/**`, `scripts/**`, `.migration/**`                | tooling/migrations, nunca UI        |

`src/lib/*.functions.ts`, services e tools de domínio não possuem exceção de persistência.
Clientes AI podem importar clientes HTTP externos, mas não DB/schema.

## Estado transitório aprovado (2026-09-05)

A regra normativa acima permanece o **alvo** das fases M02-2/3/4. O código
shipado pelas waves PERF/FIN + wave1 diverge dela em arestas BFF→DB, agora
cobertas por exceções `transient-*` no `matrix.overlay.yaml`, cada uma com razão
e fase-alvo de migração:

| Exceção overlay                    | Caminho                                         | Razão                                                                              |
| ---------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `transient-ai-modules`             | `src/lib/ai/**`                                 | budget-ledger = arquitetura de referência H-001; unidades em `transactionPolicies` |
| `transient-chat-execution`         | `src/lib/chat-execution.server.ts`              | unidades compostas de `sendChatMessage` (ADR-026); alvo M02-3                      |
| `transient-bff-chat-self`          | `src/lib/chat.functions.ts`                     | histórico de conversa na tenant tx; alvo M02-3                                     |
| `transient-bff-products-self`      | `src/lib/products.functions.ts`                 | read-model UNION na tenant tx (wave PERF); alvo M02-2                              |
| `transient-bff-expenses-self`      | `src/lib/expenses.functions.ts`                 | consulta de despesas shipada; alvo M02-4                                           |
| `transient-service-purchase-price` | `src/server/services/purchase-price.service.ts` | queries na tenant transaction (WS-01..07); alvo M02-2                              |
| `transient-service-product-detail` | `src/server/services/product-detail.service.ts` | queries na tenant transaction (WS-01..07); alvo M02-4                              |

Nenhuma exceção nova autoriza novos acessos: ampliar qualquer caminho
`transient-*` exige nova revisão. A remoção de cada exceção é critério de
saída da fase-alvo correspondente. Registro: `docs/evidence/m02-boundaries-2026-09-05.md`.

## Emenda 2026-09-06 — categoria "probe de monitoramento"

A Fase 0 do cutover A4 (`docs/runbooks/a4-a5-cutover.md`, matriz
`docs/runbooks/a4-matriz-hipoteses.md`) exige categoria explícita para sondas
de monitoramento. Define-se **probe de monitoramento**: execução sancionada e
mínima contra produção, destinada exclusivamente a verificar saúde e
integridade (ex.: `/api/health/live`+`ready`, `smoke:substrate`,
`m02:rls-probe` do smoke A4 a, re-probes das janelas A5 24h/72h). Regras:

1. Leitura por padrão; escrita somente se pré-declarada na matriz H-xx e
   exclusivamente com o domínio-marcador `@preco-que-da.test`.
2. Toda escrita de probe exige purge sancionado (`npm run db:purge-fixtures`,
   dry-run default) + re-verificação `production-fixture-free` 26/26 zero.
3. Cada probe registra evidência datada (JSON + SHA-256) em `docs/evidence/`.
4. Probe sancionado é a única causa válida de delta de escrita no
   pós-operatório — e mesmo assim deve ser classificado e registrado; probe
   fora destas regras é **VIOLAÇÃO** (achado: freeze + investigação, nunca
   deleção).
