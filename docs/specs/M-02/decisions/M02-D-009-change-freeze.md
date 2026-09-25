# M02-D-009 — Emenda normativa: change-freeze A5/B3 + roadmap M02-2/3/4 pós-B4 + norma de mutação

- **Data:** 2026-09-06 · **Tipo:** emenda normativa · **Estado:** VIGENTE (procedimental; sem assinatura)
- **Motivação:** `substrato-2026-09-05/report.md` §9 (colisão M02-2/3/4 × A5/B3); bug da guard 0010 (2026-09-06).

## 1. Change-freeze de deploys (A5 0h→72h + B3 1–2 semanas)

1. Deploys em produção **congelados** — cada deploy invalida a amostra temporal.
2. Merges em `develop` **permitidos** (inclusive M02-2/3/4), sem deploy; CI verde.
3. **Exceção única: hotfix de segurança**, com aprovação explícita do owner (go/no-go no ledger), escopo mínimo, e reinício da janela (A5 recomeça do 0h; B3 recomeça a contagem).
4. Owner é o go/no-go de A4, transições A5, entrada B3 e saída B4. Sem registro, a fase não avança.
5. Deploys retomam após B4; Fase C segue bloqueada até B4.

## 2. Roadmap M02-2/3/4 (janelas pós-B4, sem data)

- **M02-2** (products/pricing + adapters) → 1ª janela pós-B4.
- **M02-3** (contratos/adapters de chat; Memory/Event completo em M-05/M-04) → 2ª janela, após paridade M02-2.
- **M02-4** (autoridade de cálculo, Sales) → 3ª janela; precede M02-5 (enforcement) e M02-6.
- Exports antigos como adapters até paridade + 1 ciclo de compatibilidade; sem mudança de comportamento financeiro por camada.

## 3. Norma de mutação em banco (nasce do bug da guard 0010)

Todo script que escreve em banco **DEVE**: (i) rodar em **transação única** (guarda + mutação no mesmo `BEGIN…COMMIT`); (ii) default **dry-run read-only**, escrita só com flag explícita (`PURGE_APPLY=true`); (iii) **fail-closed** contra tráfego real; (iv) emitir **evidência timestamped** (JSON). Referência: `scripts/db/purge-fixtures.ts`.
