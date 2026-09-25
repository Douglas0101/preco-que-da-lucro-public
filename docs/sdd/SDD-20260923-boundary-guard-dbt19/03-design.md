# 03 — Design · SDD-20260923-boundary-guard-dbt19

## 1. Resumo da solução proposta

Encadear `m02:boundaries` e `m02:secrets-audit` no `npm run check` e replicá-los como passos diretos no
`verify` do `ui-stack.yml`, com um teste de fechamento que (a) roda as duas guardas na árvore real e
(b) **falsifica** cada uma por caso negativo.

A decisão e as alternativas estão em `docs/adr/ADR-030-boundary-guard-dbt19.md`. Este documento detalha
o **como**.

## 2. Onde exatamente cada guarda entra

| Pipeline                                             | Hoje                                                                                 | Proposto                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` (cadeia, `Definition of Done` local) | `m02:lockfile-guard → work-package → debts → temporal → seal-dts → matrix:check → …` | inserir `m02:boundaries` e `m02:secrets-audit` **após** `m02:temporal-guard` e **antes** de `m02:seal-dts:check` (agrupa as guardas baratas) |
| `ui-stack.yml` (heavy)                               | 12 dos 14 scripts da cadeia como passos diretos                                      | acrescentar os dois passos diretos, na mesma posição relativa                                                                                |
| `ci-light.yml` (light)                               | já roda `m02:secrets-audit`                                                          | **inalterado** — não duplicar                                                                                                                |
| `local-ci.sh`                                        | já roda as duas como etapas nomeadas                                                 | **inalterado** — a cobertura já é medida por `checked === discovered`                                                                        |

**Por que a cadeia _e_ o YAML:** são listas separadas. A heavy roda passos diretos, não a cadeia
inteira; alterar só uma das duas recria a divergência que gerou o achado N7 do WP-R8.

## 3. Testabilidade — a assimetria que decide os casos negativos

| Guarda              | Aceita raiz/fixture?                                                            | Consequência para o caso negativo                                                                                          |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `m02:secrets-audit` | **Sim, por export** (`auditSecrets`, `scripts/m02-secrets-audit.ts:199`)        | caso negativo **limpo**: teste importa a função e aponta para raiz sintética em `mkdtemp`. Nenhuma mutação do repositório. |
| `m02:boundaries`    | **Não** — `repositoryRoot` e `docs/specs/M-02/matrix.yaml` são fixos (`:55-56`) | caso negativo por **mutação restaurada por sha256** (padrão já usado nos selos do WP-R6/WP-R7)                             |

Alternativa adiada (A6 do ADR): dar `--root`/`--fixture` ao `boundaries`. Melhoraria o caso negativo,
mas é mudança de código do guard e amplia o escopo; fica como follow-up.

## 4. Regras de desenho (contrato do instrumento)

1. **Idempotente** — duas execuções seguidas, mesmo veredicto.
2. **Lê apenas o que declara ler:** `boundaries` lê a matriz e os caminhos que ela cita; `secrets-audit`
   varre a árvore com exclusões explícitas (`node_modules`, `docs/evidence/`, `.test.`, `package-lock.json`).
3. **Ignora artefato local declarado** — `docs/evidence/local-ci/**`, `_archive/`, bundles, patches.
   Medido: ambas passam hoje com tudo isso presente.
4. **Falha alta se não conseguir determinar o conjunto de arquivos** (matriz ilegível, git ausente) —
   hoje `loadMatrix()` lança; a implementação deve emitir **exit 2 de precondição**, distinto do `1` de
   violação (idioma do `m02-temporal-guard`).
5. **Nenhum `|| true`**, nenhum erro de comando lido como ausência de violação.
6. **Saída legível:** arquivo/regra + motivo + sugestão. `boundaries` já imprime a lista de violações por
   classe; falta a sugestão de correção.
7. **Modo diagnóstico/dry-run** desejável (não bloqueante para o fechamento).
8. **Testável com fixture sintético** — é o que T3 faz para o audit.
9. **Custo baixo** — medido em 213 ms e 1803 ms.

## 5. Impacto por área

| Área                             | Impacto                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `package.json`                   | 1 linha na cadeia `check` (2 scripts). **Não** altera dependências ⇒ lockfile intocado. |
| `.github/workflows/ui-stack.yml` | 2 passos diretos novos.                                                                 |
| Runtime/produção                 | **Nenhum.**                                                                             |
| Cota de Actions                  | +≈2,0 s sobre ≈9,7 min (≈0,3%) — não reabre o tiering.                                  |
| Evidência                        | `local-ci` já cobre; a asserção de cobertura passa a valer por identidade para os dois. |
| Registry de dívidas              | Fechamento de DBT-19 exige escrita do **MAESTRO**.                                      |

## 6. Casos de falha previstos

| Caso                                      | Sintoma                                     | Tratamento                                                                      |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| Falso positivo na árvore real             | `check` vermelho sem defeito                | **medido como baixo** (AC-03); rollback = revert do encadeamento                |
| Evidência local cresce e cai na varredura | audit reprova por artefato                  | `docs/evidence/**` já é excluído; a política `metadata-only` reduz a superfície |
| `boundaries` sem código de precondição    | exit 1 ambíguo entre violação e precondição | AC-02 exige separar `1` de `2`                                                  |
| Asserção da tabela do `AGENTS.md` frágil  | quebra a cada edição de YAML                | assertar **identidade de passo**, não texto do arquivo                          |
| Caso negativo "restaura" errado a matriz  | árvore corrompida após o teste              | restauração **verificada por sha256** + `trap` de limpeza                       |

## 7. Rollback

`git revert` do commit de implementação. Aditivo; nenhum guard muda de comportamento.
