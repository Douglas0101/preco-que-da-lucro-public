# ADR-029 — Concorrência T2: version otimista em `products`/`expenses`

- **ID:** ADR-029 · **Rastro:** §21-T2 (`docs/evidence/plan-partials-2026-09-13/part-1-arquitetura.md:47-57`) ← plano de PARTIALs 2026-09-13 · **Data:** 2026-09-13
- **Estado:** PROPOSTA / DRAFT — implementação aplicada nesta rodada (migration 0013 + CAS + lock ordering); ratificação pendente do supervisor/humano
- **Tipo:** contrato de concorrência + migration
- **Precedente de forma:** ADR-024 (contratos de integridade de dados P1); M02-D-009 §3 (norma de mutação)

## 1. Fato

1. `product.repository.ts` e `expense.repository.ts` faziam update **last-write-wins**: dois read-modify-write concorrentes partindo do mesmo estado perdiam a primeira escrita silenciosamente.
2. Em `purchase-price.repository.ts` o `pg_advisory_xact_lock` era adquirido **dentro do `append`**, isto é, **depois** do UPDATE da linha base (`product_ingredients`/`product_packaging`) feito em `DefaultPurchasePriceService.update` — a janela de corrida ficava aberta entre a leitura/escrita da linha base e a serialização do histórico.
3. A FSM da conversa persiste estado em tenant tx separada (`chat-execution.server.ts:191-205`), sem CAS contra o estado esperado.

## 2. Decisão

1. **Migration 0013 (`0013_robust_cammi`, ONLINE_WITH_CARE):** `products.version` e `expenses.version` `integer NOT NULL DEFAULT 0` + CHECK `version >= 0`. O `ADD COLUMN` é metadata-only no PG17; a validação do CHECK varre cada tabela (por isso ONLINE_WITH_CARE, com `appliedOn: "empty"` histórico).
2. **CAS otimista nos repositórios:** update usa `WHERE tenant_id = $1 AND id = $2 AND version = $esperada` e `SET version = version + 1`. `0` linhas → `CONFLICT` (409) se o registro existe; `NOT_FOUND` (404) se não existe. Update sem `version` → `VALIDATION_ERROR`. Create **omite** `version` (default do banco = 0).
3. **BFF (`M02-D-010`):** `createProductInput`/`updateProductInput` (update exige `id` + `version`); `createProduct`/`updateProduct` explícitos; `upsertProduct` vira dispatcher (sem `id` cria; com `id` sem `version` → VALIDATION_ERROR); idem despesas. `deleteProduct` permanece alias de `archiveProduct` (soft-delete). As leituras expõem `version` para o cliente atualizar.
4. **Ferramentas de IA** que escrevem produtos (`set_yield`, `set_price_and_tax`) incrementam `version` no SQL direto, mantendo o contrato sem migrar para service.
5. **Lock ordering:** `DefaultPurchasePriceService.update` adquire o advisory lock via `repository.lock(...)` **antes** do UPDATE da linha base. O `append` reentra no mesmo `pg_advisory_xact_lock` da mesma transação (advisory xact locks são reentrantes por sessão), preservando a deduplicação direta de `append` coberta por `test-migrations.ts`.
6. **`SELECT ... FOR UPDATE`** fica reservado a fluxos que precisam **ler dentro da transação e derivar a escrita da leitura**; não é o caso de products/expenses, onde o CAS cobre o read-modify-write com uma única instrução.
7. **`SERIALIZABLE` e retry de transação são T3** (fora desta rodada), assim como o CAS de estado da conversa — `persistConversationState` segue sem CAS declarado (dívida registrada, não silenciada).

## 3. Contratos e invariantes

- `version` nunca decresce (`CHECK version >= 0` + incremento atômico no UPDATE); o incremento não é escrito pelo cliente.
- `CONFLICT` (409) significa “estado mudou desde a leitura”: o cliente deve reler o recurso e reenviar com a nova `version`.
- O CAS é por `tenant_id + id`; a RLS de tenant segue como fronteira de autorização.
- O `upsert*` legado nunca faz last-write-wins: sem `version`, a atualização é rejeitada na validação.

## 4. Alternativas

| Alternativa                           | Veredito                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SELECT ... FOR UPDATE` em todo write | Rejeitada: serializa leituras/escritas sem necessidade, aumenta latência e risco de deadlock.      |
| `SERIALIZABLE` global                 | Adiada (T3): exige retry/40001 e revisão de todas as transações compostas.                         |
| Last-write-wins + auditoria           | Rejeitada: perda silenciosa de escrita em fluxo financeiro; auditoria não recupera o dado perdido. |
| Version otimista só no cliente        | Rejeitada: a invariante tem de viver no banco/UPDATE para valer contra qualquer escritor.          |

## 5. Consequências

- `drizzle/rollback/0013_to_0012_down.sql` remove constraint/coluna (destrutivo apenas para o contador; pós-tráfego o rollback canônico é restore de snapshot).
- Toda escrita de produto/despesa passa a devolver 409 em corrida; a UI ainda não trata esse código (o único consumidor de UI, `despesas.tsx`, usa apenas insert; `updateProduct`/`updateExpense` são novos exports).
- O registry de migrations vai a **14/14**; `scripts/db/test-migrations.ts`, `scripts/m02-v2b.mjs` e snapshots foram atualizados na mesma rodada.
- T3 herda: CAS de estado da conversa, avaliação de `SERIALIZABLE` e política de retry no cliente.

## 6. Evidência

- `drizzle/0013_robust_cammi.sql` · `drizzle/rollback/0013_to_0012_down.sql` · `scripts/db/migration-classes.ts` (entrada 0013)
- `scripts/db/test-migrations.ts` (colunas/CHECK + chain 0013→0003 + replay 14) · `scripts/db/test-concurrency.ts` (1 OK + 1 CONFLICT + incremento)
- `src/test/optimistic-version.repository.test.ts` · `src/test/purchase-price.service.test.ts` (lock ordering) · `src/test/bff-create-update-contract.test.ts`
- `docs/specs/M-02/decisions/M02-D-010-bff-create-update-semantics.md` · `docs/evidence/onda1-t2-bff-2026-09-13.md`
