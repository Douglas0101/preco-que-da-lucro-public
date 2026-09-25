# ADR-024 — Contratos de integridade P1 para produtos, preços, simulações e vendas

- Status: aceito
- Data: 2026-08-15
- Escopo: engenharia local, CI PostgreSQL 17 e preparação para o cutover Neon

## Contexto

O campo persistido `products.status` representa o ciclo de vida do produto, mas
completude financeira é uma projeção derivada dos insumos. O histórico de preço
era polimórfico (`subject_type`/`subject_id`) e permitia órfãos. Simulações
aceitavam `result` e versão enviados pelo cliente, e vendas calculavam o bruto
antes do arredondamento das linhas.

Esses contratos precisam ser fechados antes de qualquer migração externa. A
criação do projeto Neon, as credenciais e o cutover permanecem fora deste ADR.

## Decisões

1. `products.status` persistido mantém apenas ciclo de vida. Listas, detalhe,
   métricas e dashboard usam o mesmo read model server-side para projetar
   `ready`, `incomplete`, `active` ou `archived`.
2. O histórico de preço é temporal e append-only. Cada registro exige preço,
   quantidade e unidade; ingredientes e embalagens têm colunas de destino
   explícitas com FKs compostas `(tenant_id, id)`. A migration 0004 faz backfill
   do discriminador legado e falha se encontrar órfãos.
3. Todas as escritas de preço — BFF, upsert e ferramentas de IA — passam pelo
   serviço de preço. O mesmo valor efetivo é idempotente e não cria uma nova
   entrada de histórico.
4. Simulações persistidas aceitam somente parâmetros estritos de cenário manual.
   O servidor recalcula o resultado, fixa `finance-engine/2.0.0` e grava de forma
   append-only. `result`, `engine_version`, `scenario_type` e `id` não são
   autoridade do cliente.
5. Vendas canonicalizam quantidade/preço, arredondam cada linha a quatro casas
   e só então somam o bruto. `net_amount` não pode exceder o bruto. Checks SQL e
   trigger deferred protegem o contrato, e o runtime não recebe UPDATE em
   vendas, itens ou simulações.

## Consequências

- O frontend não pode registrar preço sem metadados de embalagem completos.
- Forecast e volume real ainda não são persistíveis como simulação até terem uma
  fonte server-side auditável.
- A migration é aditiva e mantém o discriminador legado durante a transição,
  reduzindo risco de integração; a consistência nova é garantida pelo check e
  pelas FKs explícitas.
- Testes unitários e `db:check` comprovam o contrato de código/migration. A
  execução em PostgreSQL 17 descartável e qualquer prova Neon continuam gates
  separados.

## Referências

- Plano Mestre, §§11.5–11.8, 37 e 42.
- `drizzle/0004_giant_nocturne.sql`.
- `src/server/services/product-read-model.service.ts`.
- `src/server/services/purchase-price.service.ts`.
- ADR-019 — PostgreSQL no Neon, Drizzle e isolamento por tenant.
- ADR-023 — Major PostgreSQL alvo para CI e Neon.
