# 05 — Riscos · SDD-20260923-boundary-guard-dbt19

| ID          | Risco                                                                              | Prob. | Impacto                                                          | Mitigação                                                                                    | Sinal de que ocorreu                        |
| ----------- | ---------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **RISK-01** | O teste **duplica** a lógica do guard e mascara divergência                        | média | o teste passa enquanto a guarda real quebrou                     | executar o **script real** (padrão de `m02-ci-tiers.test.ts`), nunca uma cópia               | teste verde + guarda quebrada               |
| **RISK-02** | O caso negativo de `boundaries` **não restaura** a matriz                          | baixa | árvore corrompida; `matrix:check` vermelho depois                | restauração com `trap` + **conferência de sha256** contra o valor capturado antes da mutação | sha256 diferente do original                |
| **RISK-03** | A asserção da tabela do `AGENTS.md` fica **frágil** (quebra a cada edição de YAML) | média | manutenção cara; pressão para remover o teste                    | assertar **presença/ausência por identidade** de passo, nunca o texto do arquivo             | falha do teste em edição inocente           |
| **RISK-04** | Cadeia `check` e passos do YAML **divergem**                                       | média | cobertura real ≠ cobertura declarada — a lacuna que gerou DBT-19 | T6 asserta as duas fontes; T8 atualiza a tabela no mesmo commit                              | tabela `✔` sem passo correspondente         |
| **RISK-05** | Falso positivo na árvore real derruba o `check` de todos                           | baixa | bloqueio de desenvolvimento                                      | **medido: ambas passam hoje** (AC-03, 3/3); rollback = revert do encadeamento                | `check` vermelho sem defeito real           |
| **RISK-06** | Custo cresce além do medido (ex.: árvore de evidência grande)                      | baixa | reabre a discussão de cota                                       | re-medir após a integração (T9); `docs/evidence/**` já é excluído do audit                   | T9 acima de 3 s                             |
| **RISK-07** | `boundaries` confunde violação com precondição                                     | média | exit ≠ 0 correto mas **ilegível**; AC-02 não satisfeito          | T5 separa `1` de `2` (idioma do `m02-temporal-guard`)                                        | mensagem de precondição em caso de violação |
| **RISK-08** | Fechar DBT-19 sem o caso negativo                                                  | baixa | viola a condição **verbatim** do registry                        | T2/T3 são pré-requisito de T11; o fechamento é do MAESTRO                                    | DBT-19 fechada sem closure test executável  |
| **RISK-09** | Implementar sem aprovação (por conveniência)                                       | baixa | viola o contrato deste ciclo e o §3.21 das restrições            | ADR-030 fica em PROPOSTA; nada é tocado até `APPROVE_DBT19_CONTRACT`                         | `package.json` alterado sem aprovação       |

## Risco aceito conscientemente

**RISK-10 — o caso negativo de `boundaries` muta um arquivo rastreado.** É o preço de o guard não
aceitar raiz/fixture (fato 5 do ADR). O padrão já existe neste repositório (mutação restaurada por
sha256 nos selos do WP-R6/WP-R7) e a alternativa limpa (A6: `--root` no guard) foi **adiada**, não
descartada — fica registrada como follow-up, e reduziria este risco a zero.

## Não-riscos (verificados por medição, não por suposição)

- **Rede:** nenhuma das duas guardas importa qualquer módulo de rede (só `node:fs`, `node:path`,
  `node:url`).
- **Banco:** nenhuma abre conexão; o tier de banco do `local-ci` é decidido por escopo e não tem relação
  com estas guardas.
- **Plataforma/CI remoto:** ambas rodam local; a light já as executa **sem instalar dependências**.
- **Segredos:** a saída do audit é `{path, reason}` — nunca o valor casado.
- **Runtime de produção:** nenhum artefato de produção é tocado.
