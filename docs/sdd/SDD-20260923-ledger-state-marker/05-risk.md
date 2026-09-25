# 05 — Riscos · SDD-20260923-ledger-state-marker

| ID          | Risco                                                                                                | Prob. | Impacto                                                                           | Mitigação                                                                                                          | Sinal de que ocorreu                           |
| ----------- | ---------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **RISK-01** | SHA errado na linha do marcador (ex.: usar HEAD em vez do parent)                                    | média | check continua vermelho; ciclo não fecha                                          | `git rev-parse HEAD` imediatamente antes da edição; o valor gravado é sempre o **parent** do commit que o carrega  | `Ledger M-02 desatualizado` persistente        |
| **RISK-02** | O commit da correção não atualizar o marcador (esquecer a disciplina)                                | média | vermelho recorrente no tip                                                        | cada commit do ciclo carrega a sua linha; `TASK-08` atualiza o marcador para o parent de B                         | idem                                           |
| **RISK-03** | Bloco novo quebra o `m02:temporal-guard` (âncora que não resolve / data vencida após verbo de prazo) | média | `check` vermelho; pipeline local falha                                            | citar apenas SHAs verificados; **não** usar verbos de prazo; rodar o guard antes do commit                         | `m02-temporal-guard: violacao` no log da etapa |
| **RISK-04** | Prettier reflui tabelas do journal/ledger e o diff fica maior que o pretendido                       | alta  | diff ruidoso; dificulta revisão                                                   | rodar `prettier --write` **antes** do commit e revisar `git diff --stat`                                           | diff tocando linhas não relacionadas           |
| **RISK-05** | A correção virar reescrita de história por hábito (`--amend`)                                        | baixa | viola §3.6 e `AGENTS.md`                                                          | proibido por contrato; a alternativa aditiva (A5) remove a motivação                                               | `git log` mostrando SHA antigo reescrito       |
| **RISK-06** | Push acidental ao "fechar" o ciclo                                                                   | baixa | queima cota bloqueada e produz run `failure` sem evidência (caso `L154`)          | nenhum comando de push no ciclo; verificação explícita de `origin/develop` inalterado                              | `origin/develop` deixa de ser `a2f5ff6…`       |
| **RISK-07** | Confundir "check verde" com "dívida resolvida"                                                       | média | conclusão falsa: o check voltar a verde **não** significa que a causa raiz morreu | declarar explicitamente que a causa raiz (o check não pertencer a gate nenhum) segue aberta e é o objeto do item 6 | prosa afirmando resolução definitiva           |

## Risco aceito conscientemente

**RISK-08 — o marcador voltará a defasar no próximo commit que não o atualize.** Enquanto
`m02:state:check` não pertencer a um gate automatizado, a disciplina depende de quem commita. Este SDD
**não** fecha essa causa raiz; apenas restaura o verde e a deixa nomeada. O fechamento é o item 6
(`SDD-20260923-local-ci-hardening`, requisito de gate dedicado) — que exige decisão humana por mudar
contrato de CI.

## Não-riscos (verificados)

- **Runtime:** nenhum arquivo lido em runtime foi tocado.
- **Segurança:** nenhum segredo, credencial ou superfície de rede envolvida.
- **Banco:** nenhuma conexão; o ciclo não abre container nem toca `:5432`.
- **Plataforma:** nenhuma chamada à API do GitHub; nenhuma dependência de billing.
