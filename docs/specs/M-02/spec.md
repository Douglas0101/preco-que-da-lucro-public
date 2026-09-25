# M-02 — Arquitetura uniforme F3/F4

Status: `DRAFT` até RAT humano; esta especificação não autoriza merge ou publicação.

## Objetivo

Fechar a fronteira `UI/server function → application service → repository → PostgreSQL`
para os caminhos de domínio de products, pricing, despesas, vendas, simulações,
diagnóstico e conversa. A especificação preserva o comportamento existente durante a
migração e torna acessos, transações, DTOs e proveniência verificáveis por código.

## Escopo

- inventário transitivo de server functions, rotas auxiliares, services, repositories e DB;
- catálogo normativo de services e repositories;
- `Executor` e `TransactionManager` para unidades de trabalho;
- DTOs financeiros decimais e `CalculationResult` canônico;
- autoridade server-side do diagnóstico e módulo puro compartilhado de simulação;
- contratos/adapters de Conversation, Memory, Audit e Event.

## Métricas do inventário

As contagens da matriz representam dimensões diferentes e não podem ser usadas como
sinônimos:

- `transactionSites`: ocorrências lexicais de `context.transaction` ou
  `request.transaction` classificadas pelo gerador; o baseline atual contém 13;
- `directDatabaseFiles`: arquivos TypeScript que importam ou alcançam persistência no
  grafo analisado; o baseline atual contém 21;
- `concreteOperations`: operações BFF concretas/aliases, atualmente 31.

A especificação não chama os 21 arquivos alcançáveis de sites transacionais. Uma mudança
de contagem deve ser acompanhada de regeneração da matriz e de evidência no SHA
correspondente.

## Fora do escopo

- implementação completa de MemoryService, policy engine, FTS, delete/export e embeddings — M-05;
- outbox e settlement completo de eventos de uso — M-04;
- credenciais reais, endpoint Neon, migração/cutover e produção;
- alteração de `docs/adr/ADR-021-migration-cutover-supabase-neon.md`;
- merge automático, push, PR ou aprovação de valores golden.

## Autoridade por tipo

1. requisitos legais/de segurança, Constituição, decisões humanas aprovadas e proibições;
2. V7 para fases, status e dependências do programa;
3. Plano Mestre, Arquitetura Consolidada e Diretriz para o catálogo M-02;
4. SDD para contratos comportamentais e invariantes de domínio;
5. Plano Operacional para a sequência de execução;
6. esta spec para detalhamento operacional, sem contradizer as camadas anteriores.

Os identificadores de decisão deste módulo são `M02-D-001..005`. ADRs numéricos legados
só podem ser citados com o documento de origem.

## Fronteira e allowlist

Acesso direto a DB é permitido somente para health/readiness, auth/membership,
rate-limit e migrations/scripts. Server functions de domínio, services e tools de IA
não podem importar Drizzle/schema diretamente. Clientes externos de IA não recebem
permissão de persistência; gravações passam por services/repositories.

> **Registro transitório (2026-09-05):** o código shipado pelas waves PERF/FIN +
> wave1 diverge desta regra em 11 arestas BFF→DB, cobertas por exceções
> `transient-*` documentadas em `excecoes.md` (§ Estado transitório aprovado) e no
> overlay, cada uma com fase-alvo de remoção (M02-2/3/4). Esta spec permanece
> DRAFT; a regra normativa acima continua sendo o alvo e nenhuma exceção
> transitória autoriza novos acessos. Evidência:
> `docs/evidence/m02-boundaries-2026-09-05.md`.

## Contrato financeiro

- dinheiro: `Decimal` no domínio e `DecimalString` em DTO/DB, escala 4;
- quantidade: escala 6;
- percentual: fração entre 0 e 1, escala 6;
- arredondamento monetário: `ROUND_HALF_UP`;
- unidades discretas: `ceil` para o mínimo necessário;
- `number` somente em apresentação/telemetria delimitada;
- estados: `valid`, `incomplete`, `notApplicable`, `invalid`;
- `unknown` nunca é convertido em zero.

## Autoridade de cálculo

- diagnóstico corrente: `DiagnosticService`/read model server-side;
- simulação what-if: módulo puro compartilhado, com recálculo server-side antes de salvar;
- totais de despesas: `ExpenseService`;
- ponto de equilíbrio: adapter do serviço decimal existente;
- thresholds: regras versionadas com `rulesVersion`, owner e origem;
- snapshots: híbridos — compute-on-read para estado corrente e persistência para histórico,
  exportação ou simulação explicitamente salva.

## Catálogo-alvo

Services: Product, Pricing, Expense, Sales, Simulation, Diagnostic, Conversation,
Memory, Audit e Event.

Repositories: Product, Ingredient, Packaging, Price, MarketPrice, Expense, Sales,
Simulation, Conversation, Memory, CalculationSnapshot, Audit e Event.

M-02 entrega contratos e adapters dos componentes que pertencem à sequência M-04/M-05;
suas implementações completas permanecem nesses módulos.

## Critério de congelamento

O status só pode mudar para `FROZEN` quando `matrix.yaml` for compilada de forma
determinística, todas as entradas tiverem service/repository/DTO/atomicidade ou exceção,
os conflitos documentais estiverem registrados e um RAT humano aprovar o artefato.

O check semântico também deve confirmar que as contagens declaradas correspondem aos
arrays gerados, que os 13 sites transacionais estão classificados, que os 21 arquivos
de persistência são únicos e que as seis unidades compostas de `sendChatMessage` estão
presentes no overlay.
