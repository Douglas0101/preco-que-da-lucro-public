# Preço que Dá Lucro

Plataforma web em português (pt-BR) de **precificação inteligente assistida por IA, voltada exclusivamente ao setor de alimentação** — restaurantes, lanchonetes, padarias, confeitarias, bares, delivery e demais negócios de alimentos e bebidas. Cobre estruturação de custos de ingredientes, rendimento de receitas, embalagens, formação de preço, margem de contribuição, ponto de equilíbrio, despesas, vendas, simulações e diagnóstico financeiro — com cadastro conversacional de produtos e assistente de IA.

> O projeto está em programa de engenharia orientado a invariantes: nenhuma otimização de performance ou experiência pode mascarar cálculo incorreto, falha de autorização ou erro silencioso. A ordem é: **correção matemática → segurança → integridade dos dados → fronteiras arquiteturais → estabilidade → observabilidade → performance → experiência → escala**.

## Estado do projeto

| Item               | Status                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI (`ui-stack`)    | Verde — baseline completa no run [30732769570](https://github.com/Douglas0101/preco-que-da-lucro/actions/runs/30732769570) (SHA `ecea55a`)                       |
| Gates ativos       | format, lint, typecheck, testes unitários, build sem warnings não registrados, budget de bundle, matriz Playwright (Chromium/Firefox/WebKit), `npm audit --high` |
| Bundle (baseline)  | entry 231581 bytes; grafo estático 423418 bytes                                                                                                                  |
| Exceção temporária | `WARN-NITRO-001` (warning conhecido do Nitro beta) válida somente para `local`/`pre-beta-internal` até **2026-09-01** — ver `docs/evidence/`                     |
| Produção           | Bloqueada pelos gates de release da SDD e pela exceção acima                                                                                                     |
| Branching          | `develop` (trabalho diário) → `main` (release, somente via PR com CI verde) — ADR-017                                                                            |

## Stack atual

- **App**: TanStack Start/Router (Release Candidate), React 19, TypeScript 5.8, Vite 8 + Nitro 3 (beta pinado).
- **UI**: Tailwind CSS 4, shadcn/ui sobre Base UI como camada exclusiva de primitivos (ADR-016).
- **Dados canônicos (P0)**: PostgreSQL no Neon, acessado pelo BFF via Drizzle; Supabase não participa do runtime e só pode ser origem read-only da migração única.
- **Validação**: Zod em contratos e ferramentas de IA.
- **Testes**: Vitest (unitários), Playwright (E2E multi-browser com axe).
- **Toolchain pinada**: Node `24.15.0` (`.nvmrc`), npm `11.14.1`; Actions do GitHub fixadas por SHA.

## Arquitetura-alvo

Definida em [`docs/ARQUITETURA_CONSOLIDADA_PRECO_QUE_DA_LUCRO.md`](./docs/ARQUITETURA_CONSOLIDADA_PRECO_QUE_DA_LUCRO.md). Cinco responsabilidades separadas explicitamente:

1. **PostgreSQL** mantém a verdade persistente do sistema (Neon como provedor inicial, substituível).
2. **O domínio** mantém as regras e invariantes de negócio.
3. **O Financial Engine** mantém a matemática financeira determinística (decimal exato, arredondamento explícito, `Unknown ≠ Zero`, snapshots versionados de cálculo).
4. **A IA** interpreta contexto, conversa, orienta e explica — sem executar SQL e sem se tornar fonte de verdade financeira.
5. **A memória** (camadas L0–L5: working, sessão, episódica, semântica, referências de domínio, procedural) não duplica a verdade financeira.

Fluxo de dados: **Frontend → BFF (TanStack Start, única fronteira de API) → Application Services → Repositories → PostgreSQL**. O frontend nunca acessa o banco diretamente; toda tool da IA tem validação runtime; ações críticas são auditáveis; graceful degradation cobre IA, busca vetorial e observabilidade externa indisponíveis.

## Roadmap

Macro-roadmap do [`docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md`](./docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md):

```text
F0  Baseline e observabilidade        F8  Migração Supabase → PostgreSQL/Neon
F1  P0 financeiro e segurança         F9  Orquestração de IA
F2  Autenticação server-driven        F10 Memória persistente
F3  BFF como fronteira única          F11 Performance backend
F4  Services + Repositories           F12 Performance frontend
F5  Financial Engine 2.0              F13 UX e explicabilidade
F6  PostgreSQL schema hardening       F14 Resiliência e SLOs
F7  Preparação Neon                   F15 Hardening de produção
```

Prioridades: **P0** (segurança e correção: XSS no chat, Result Type, Unknown/NaN ≠ zero, dados fictícios, Zod em tools), **P1** (arquitetura: BFF, services, repositories, PostgreSQL/Neon), **P2** (memória avançada, resiliência, escala). Cada fase tem gate de conclusão e matrizes de regressão financeira, segurança e integridade.

## Princípios não negociáveis

```text
INV-001 Frontend não acessa PostgreSQL diretamente.
INV-002 Nenhuma server function privada confia apenas em beforeLoad.
INV-003 IA não executa SQL.
INV-004 IA não calcula valor financeiro canônico.
INV-005 Memória de IA não substitui dado financeiro.
INV-006 Unknown não é zero.
INV-007 NaN/Infinity não são formatados como zero.
INV-008 Tenant A jamais referencia entidade de Tenant B.
INV-009 Toda mutação crítica é transacional ou explicitamente compensável.
INV-010 Runtime usa usuário PostgreSQL de menor privilégio.
INV-011 Neon é substituível.
INV-012 Migrations são reproduzíveis.
INV-013 Erros de DB não são transformados em sucesso vazio.
INV-014 Toda tool da IA possui validação runtime.
INV-015 Resultados financeiros relevantes registram versão do motor.
```

## Desenvolvimento

Pré-requisitos: Node `24.15.0` (use `nvm use`) e npm `11.14.1`.

```sh
git clone https://github.com/Douglas0101/preco-que-da-lucro.git
cd preco-que-da-lucro
npm ci
npm run dev
```

Scripts de qualidade (todos bloqueantes na CI):

```sh
npm run format:check   # Prettier
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run test           # Vitest
npm run build          # build com política zero-warning (scripts/build.mjs)
npm run check:bundle   # budgets de bundle
npm run test:e2e       # Playwright (Chromium, Firefox, WebKit)
npm run check          # todos os gates em sequência
```

## Qualidade e CI

A workflow [`ui-stack`](./.github/workflows/ui-stack.yml) roda em pushes para `main` e `develop` e em todo pull request: `npm ci`, check de stack de UI, format, typecheck, lint, testes unitários, build (warnings não registrados falham o build), budget de bundle, matriz Playwright e `npm audit --audit-level=high`. Artifacts de bundle e de browsers registram o SHA completo do commit.

A política de warnings do build aceita somente assinaturas exatas com exceção registrada, owner, justificativa e expiração (`docs/evidence/build-warning-policy-2026-08-02.md`).

## Branching

- **`develop`** — trabalho diário (desenvolvimento, engenharia, cibersegurança). Commits diretos permitidos; CI completa a cada push.
- **`main`** — release. Recebe merges somente via PR `develop → main` com CI verde; é a branch default do repositório.
- Nunca force-push, rebase ou amend em commits já publicados.
- Detalhes em [`docs/adr/ADR-017-branching-strategy.md`](./docs/adr/ADR-017-branching-strategy.md).

## Documentação

| Documento                                                                                                                                                                      | Conteúdo                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`docs/DIRETRIZ_PRECIFICA_PRECO_QUE_DA_LUCRO_V7_SHADCN_BASEUI_SINCRONIZADO_OFICIAL.md`](./docs/DIRETRIZ_PRECIFICA_PRECO_QUE_DA_LUCRO_V7_SHADCN_BASEUI_SINCRONIZADO_OFICIAL.md) | **Diretriz primária** consolidada de produto, arquitetura e engenharia (V7) — prevalece em divergências |
| [`docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md`](./docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md)                                       | Plano mestre validado: evidências, fases F0–F15, prioridades, gates, KPIs (referência detalhada)        |
| [`docs/ARQUITETURA_CONSOLIDADA_PRECO_QUE_DA_LUCRO.md`](./docs/ARQUITETURA_CONSOLIDADA_PRECO_QUE_DA_LUCRO.md)                                                                   | Arquitetura-alvo: camadas, Financial Engine, IA, memória, ADRs (referência detalhada)                   |
| [`docs/MAPA_CRUZADO_DIRETRIZ_PLANO_PRECO_QUE_DA_LUCRO.md`](./docs/MAPA_CRUZADO_DIRETRIZ_PLANO_PRECO_QUE_DA_LUCRO.md)                                                           | Cruzamento Diretriz × Plano: rastreabilidade, lacunas e reavaliação sob a V7                            |
| [`SDD.md`](./SDD.md)                                                                                                                                                           | Especificação técnica normativa (v1.4)                                                                  |
| [`docs/adr/`](./docs/adr/)                                                                                                                                                     | ADRs aceitos (016 shadcn/Base UI, 017 branching)                                                        |
| [`docs/evidence/`](./docs/evidence/)                                                                                                                                           | Evidências de gates: CI, build warnings, acessibilidade                                                 |

## Licença

Repositório privado. Todos os direitos reservados.
