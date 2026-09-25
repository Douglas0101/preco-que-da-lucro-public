# 04 — Plano · SDD-20260923-boundary-guard-dbt19

Plano executável. **Nada além de T0 foi executado** — T1 em diante dependem de aprovação do contrato
(ADR-030 §8).

| ID      | Tarefa                                                  | Ação                                                                             | Conclusão                                               | Risco                                                 | Depende de | Estado       |
| ------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- | ---------- | ------------ |
| **T0**  | Medir custo e precondições das duas guardas             | 3 execuções cronometradas + leitura de imports                                   | tabela de custo + ausência de rede/DB                   | nenhum (leitura)                                      | —          | **✅ FEITO** |
| **T1**  | Escrever o teste de fechamento (verde na árvore real)   | `src/test/m02-boundary-gate.test.ts`: roda as duas guardas                       | exit 0 nas duas                                         | duplicar lógica no teste (`RISK-01`)                  | aprovação  | ☐            |
| **T2**  | Caso negativo de `secrets-audit`                        | teste importa `auditSecrets` com raiz `mkdtemp` + segredo falso                  | `failures.length > 0`                                   | fixture vazar para a árvore                           | T1         | ☐            |
| **T3**  | Caso negativo de `boundaries`                           | script de captura: muta `matrix.yaml` → roda → **restaura por sha256** → confere | exit 1 nomeando a violação; sha256 idêntico ao original | árvore corrompida se a restauração falhar (`RISK-02`) | T1         | ☐            |
| **T4**  | Caso de precondição                                     | matriz ilegível em fixture (ou ausente)                                          | exit ≠ 0 **de precondição** (2), nunca sucesso          | —                                                     | T1         | ☐            |
| **T5**  | Separar `1` de `2` em `boundaries`                      | código do guard: violação = 1, precondição = 2                                   | AC-02 satisfeito                                        | mexe em guard existente ⇒ escopo maior                | T4         | ☐            |
| **T6**  | Asserção da tabela do `AGENTS.md`                       | teste compara tabela × YAMLs × cadeia `check`, por identidade                    | falha ao remover um passo do YAML                       | acoplamento frágil (`RISK-03`)                        | T1         | ☐            |
| **T7**  | Encadear no `check` + passos diretos do heavy           | `package.json` (2 scripts) + `ui-stack.yml` (2 passos)                           | cadeia e YAML em sincronia                              | divergência cadeia×YAML (`RISK-04`)                   | T2, T3, T6 | ☐            |
| **T8**  | Atualizar a tabela do `AGENTS.md` no **mesmo commit**   | mover os `✘` de `m02:boundaries`/`m02:secrets-audit` para `✔`                    | tabela bate com os YAMLs                                | regra do repo: quem muda o documentado atualiza o doc | T7         | ☐            |
| **T9**  | Re-medir custo com a integração real                    | 3 execuções de `npm run check`                                                   | delta ≤ 3 s                                             | —                                                     | T7         | ☐            |
| **T10** | `npm run check` + `./scripts/local-ci.sh` + evidência   | validação completa e selagem por SHA                                             | `verdict=success`                                       | ~6 min                                                | T8, T9     | ☐            |
| **T11** | Preparar o texto de fechamento de DBT-19 para o MAESTRO | nota com closure test apontando para o teste                                     | nota entregue                                           | escritor é o MAESTRO                                  | T10        | ☐            |

## Ordem obrigatória e por quê

- **Casos negativos (T2, T3) antes do encadeamento (T7).** Encadear primeiro criaria um gate cuja
  capacidade de reprovar ninguém provou — exatamente a lacuna que DBT-19 denuncia.
- **T5 antes de T7** se AC-02 for exigido no fechamento: um guard que confunde violação com precondição
  dá exit ≠ 0 nos dois casos (fail-closed, mas ilegível) e não satisfaz o critério.
- **T8 no mesmo commit de T7** — regra explícita do `AGENTS.md`.
- **T11 por último** — o fechamento no registry é ato do MAESTRO e só faz sentido com o closure test
  existente.

## Timebox

- T0: **feito** (minutos).
- T1–T6: a maior parte do esforço (testes + 1 ajuste de guard).
- T7–T10: minutos de edição + ≈6 min de validação.
- **Sem** dependência de rede, DB, credencial ou da plataforma bloqueada em nenhuma tarefa.
