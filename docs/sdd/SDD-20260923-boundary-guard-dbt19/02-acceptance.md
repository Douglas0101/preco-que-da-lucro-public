# 02 — Critérios de aceite · SDD-20260923-boundary-guard-dbt19

| ID        | Critério                                                          | Comando / verificação                                                           | Esperado                                       | Estado                                                                                                                                   |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-01** | A guarda falha se uma boundary declarada for violada              | T2: mutação de `matrix.yaml` (entry não-allowlisted) + `npm run m02:boundaries` | exit ≠ 0 nomeando `bff -> path`                | **planejado** (caso negativo a implementar)                                                                                              |
| **AC-02** | A guarda falha se uma precondição necessária estiver indisponível | T4: matriz ilegível/ausente                                                     | exit ≠ 0 **de precondição**, nunca sucesso     | **planejado** — hoje `loadMatrix()` lança (não-zero, mas sem código de precondição dedicado): a implementação deve distinguir `1` de `2` |
| **AC-03** | A guarda passa na árvore atual **sem falso positivo**             | `npm run m02:boundaries` e `npm run m02:secrets-audit` na árvore real           | exit 0                                         | **MEDIDO ✅** — 3/3 execuções de cada, com toda a evidência local presente                                                               |
| **AC-04** | O closure test aponta para um teste **executável**                | arquivo de teste versionado, encadeado no `test`                                | roda e falha quando a guarda deixa de reprovar | **planejado**                                                                                                                            |
| **AC-05** | O custo é medido em **pelo menos 3 execuções**                    | cronometragem individual                                                        | tabela com 3 linhas por guarda                 | **MEDIDO ✅** — 240/204/197 ms e 1781/1802/1828 ms                                                                                       |
| **AC-06** | Custo por guarda ≤ 3 s (ou justificativa registrada)              | derivado de AC-05                                                               | ≤ 3000 ms                                      | **MEDIDO ✅** — 213 ms e 1803 ms                                                                                                         |
| **AC-07** | A integração **não** depende de GitHub Actions                    | inspeção de imports + execução local                                            | roda sem plataforma                            | **MEDIDO ✅** — ambas rodam local; a light já as executa **sem `npm ci`**                                                                |
| **AC-08** | A integração **não** depende de rede                              | inspeção de imports                                                             | nenhum `fetch`/host                            | **MEDIDO ✅** — só `node:fs`, `node:path`, `node:url`                                                                                    |
| **AC-09** | A integração **não** expõe segredos                               | revisão do `m02:secrets-audit`                                                  | nenhum valor ecoado; só caminho + motivo       | **MEDIDO ✅** — a saída do audit é `{path, reason}`, nunca o conteúdo                                                                    |
| **AC-10** | A evidência `metadata-only` **não** quebra a guarda               | rodar com `docs/evidence/local-ci/**` presente                                  | exit 0                                         | **MEDIDO ✅** — `m02:secrets-audit` **exclui** `docs/evidence/**` por construção; `m02:boundaries` lê só a matriz                        |

## Regra anti-vacuidade

- **AC-01 e AC-02 são os únicos que provam que a guarda é uma guarda.** AC-03 (verde na árvore atual) é
  satisfeito por uma guarda que **nunca** reprova — é o teste que o registry recusa como suficiente.
  Por isso o fechamento de DBT-19 exige AC-01 **e** AC-04 conjuntamente.
- **AC-04 exige executabilidade, não existência.** Um arquivo de teste que não está encadeado em nenhum
  runner não satisfaz: o closure test tem de **falhar** quando a guarda é neutralizada.
- **AC-05/AC-06 são medição, não estimativa.** Os números acima foram cronometrados nesta máquina; se a
  implementação mudar o que roda, a medição é **refeita** — o custo do estado atual não transfere.
- **`checked === discovered`:** os 10 critérios desta tabela são os 10 declarados na SPEC; um critério
  declarado sem linha aqui é lacuna, não omissão tolerada.
