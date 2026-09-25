# M02-D-010 — Semântica create/update nos BFFs de `products` e `expenses` (CAS otimista)

- **Data:** 2026-09-13 · **Tipo:** decisão de contrato de API (precedente M02-D-001..009) · **Estado:** VIGENTE na implementação da Onda 1 (ratificada no plano §4; `part-1-arquitetura.md` BFF-002/003)
- **Rastro:** `docs/evidence/plan-partials-2026-09-13/PLANO.md:36` · `part-1-arquitetura.md:59-65` · ADR-029

## 1. Contexto

`upsertProduct`/`upsertExpense` misturavam insert e update no mesmo schema (`id` opcional), sem versão e sem distinguir as semânticas. Com o CAS otimista (ADR-029), a atualização precisa exigir a `version` corrente — um `id` sem `version` não pode mais cair no caminho de update.

## 2. Decisão

### 2.1 `src/lib/products.functions.ts`

- `createProductInput`: campos de produto **sem** `id`/`version`; exporta `createProduct` (insert; banco inicia `version = 0`).
- `updateProductInput`: campos + `id: uuid` **e** `version: integer >= 0` obrigatórios; exporta `updateProduct` (CAS).
- `upsertProduct` (legado): dispatcher — sem `id` cria; com `id` + `version` atualiza; `id` sem `version` → `VALIDATION_ERROR`; `version` sem `id` → `VALIDATION_ERROR`.
- `deleteProduct` permanece **alias de `archiveProduct`** (`deleteProduct = archiveProduct`): exclusão é soft-delete recuperável (nota de compatibilidade).
- As leituras (`mapProduct`) expõem `version` para o cliente enviar no update.

### 2.2 `src/lib/expenses.functions.ts`

- Mesma divisão: `createExpenseInput`/`updateExpenseInput`, `createExpense`/`updateExpense`; `upsertExpense` vira dispatcher com a mesma regra de `VALIDATION_ERROR`.
- A UI atual (`despesas.tsx`) usa `upsertExpense` apenas para **insert** (sem `id`); nenhum consumidor existente de update é quebrado.

### 2.3 Matrix M-02

- `operationPolicies` de `products.functions.ts`/`expenses.functions.ts` ganham `createProduct`, `updateProduct`, `createExpense`, `updateExpense` (service/repository/atomicity equivalentes aos irmãos `upsert*`), com nota de que `deleteProduct` mapeia `archiveProduct`.
- Aplicação é **manifest request** ao supervisor (fora do escopo de escrita do operador), seguida de `npm run m02:matrix:generate`.

## 3. Consequências

- Clientes que atualizavam produto via `upsertProduct` com `id` agora recebem `VALIDATION_ERROR` até enviarem `version`; é a mudança de contrato deliberada do CAS.
- `createProduct`/`createExpense` não aceitam `id` (não há como forçar update pelo caminho de criação).
- Erros de corrida chegam como `CONFLICT` (409), com a semântica “relê e reenvia com a versão nova”.

## 4. Evidência

- `src/test/bff-create-update-contract.test.ts` (contrato estático dos 4 exports + schemas)
- `src/test/optimistic-version.repository.test.ts` (CAS nos repositórios)
- `scripts/db/test-concurrency.ts` (1 update OK + 1 CONFLICT + incremento)
- `docs/evidence/onda1-t2-bff-2026-09-13.md` (gates e manifest requests)
