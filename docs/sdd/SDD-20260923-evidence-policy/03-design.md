# 03 — Design · SDD-20260923-evidence-policy

## 1. Resumo da solução

Três peças, todas dentro de `scripts/local-ci.sh` (nenhuma mudança em `.gitignore`):

1. **Bloco `evidence` no manifesto**, com política e contagens **medidas**, não estimadas.
2. **`evidence.git.sha256`** — selo restrito ao conjunto versionável, obtido por
   `git ls-files --cached --others --exclude-standard`, que já resolve o caso "arquivo ainda não
   commitado" (é o ponto que quebra a receita ingênua com `git ls-files` puro).
3. **Etapa `evidence-policy-check`** — verificação fail-closed que compara a **declaração** do manifesto
   com o **mundo** medido por `git check-ignore`.

## 2. Alternativas consideradas

| #      | Alternativa                                                                                                            | Por que não                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1     | `git ls-files -z docs/evidence/local-ci/<sha> \| xargs -0 sha256sum` (receita do enunciado)                            | **Não funciona neste momento do ciclo:** a evidência é **untracked** quando o selo é gerado, então `git ls-files` devolve vazio e o selo sai vazio. Só serviria depois do commit, criando dependência circular.                                      |
| B2     | Desligar `*.log` no `.gitignore` (política `full-logs`)                                                                | Mudança de política do repo, exige aprovação humana; e 58 logs crus num commit é exatamente o que a política padrão quer evitar.                                                                                                                     |
| B3     | Não gerar segundo selo; confiar só no `<sha>.sha256`                                                                   | O selo integral inclui logs que **nunca** serão versionados, logo não responde "o que exatamente foi versionado?" — que é a pergunta da auditoria de push futuro.                                                                                    |
| B4     | Filtrar por extensão (lista de exclusão `*.log`)                                                                       | Enumeração por lista conhecida: um artefato novo ignorado (ex.: `*.bundle`, `*.patch`, `.pcap`) escaparia em silêncio. É a quarta ocorrência dessa família já registrada no repo (`WP4-N1`, `WP-R3-N4`, `WP-R5-N3`, contador `directDatabaseFiles`). |
| **B5** | **`git ls-files --cached --others --exclude-standard` + verificação por `git check-ignore` com igualdade de contagem** | **Escolhida.** Deriva o conjunto do **próprio mecanismo do Git**, não de uma lista mantida à mão, e a igualdade de contagem falha alto se um arquivo novo mudar de classe.                                                                           |

## 3. Decisão escolhida

**B5.**

## 4. Justificativa

- O conjunto versionável é **definido pelo Git**, então não pode divergir do que um `git add` faria.
- `--others --exclude-standard` inclui untracked-não-ignorado: resolve a circularidade sem exigir commit
  prévio do metadata.
- A verificação compara **declaração × mundo** e usa **contagem exata** — a mesma disciplina
  `checked === discovered` dos selos do repo.
- Zero mutação de configuração do repositório.

## 5. Impacto em arquivos

| Arquivo                                            | Mudança                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `scripts/local-ci.sh`                              | bloco `evidence` no manifesto; geração de `evidence.git.sha256`; nova etapa `evidence-policy-check` |
| `docs/evidence/local-ci/<sha>/evidence.git.sha256` | arquivo novo                                                                                        |
| `docs/evidence/local-ci/<sha>/manifest.json`       | campos novos                                                                                        |
| `.gitignore`                                       | **nenhuma** (requisito REQ-06)                                                                      |

## 6. Impacto em CI

- `scripts/local-ci.sh` está sob `scripts/**`, que **sempre** vai para o pipeline heavy (nunca para a
  light). Se houvesse push, a heavy rodaria — mas **não há push** neste ciclo (cota bloqueada).
- Nenhum gate existente é alterado; a etapa nova vive **dentro** do pipeline local, não no `check`.

## 7. Impacto em ledger/journal

O `✔` do journal cita a política adotada e o ponteiro do selo versionável.

## 8. Impacto em evidência

É o objeto. Muda a **declaração** e adiciona um selo; o selo integral anterior permanece intacto
(cobertura de tudo, inclusive dos logs).

## 9. Impacto em segurança

**Positivo:** o selo versionável separa explicitamente o que pode ir a um repositório do que fica só na
máquina. Nenhum segredo é versionado. Os logs locais permanecem fora do commit — reduzindo a superfície
de exposição acidental de conteúdo de ambiente.

## 10. Impacto em performance

Desprezível: `git ls-files`/`git check-ignore` sobre ~119 caminhos, uma vez por execução (< 50 ms).

## 11. Estratégia de rollback

`git revert <commit>` do script. O `evidence.git.sha256` deixa de ser gerado; o selo integral e os
relatórios continuam válidos.

## 12. Pontos de observabilidade

- `steps.tsv`: linha `evidence-policy-check` com status.
- `manifest.evidence.*`: política + contagens.
- `evidence-policy-check.log`: as contagens medidas e o veredicto.

## 13. Casos de falha

| Caso                                                                | Sintoma               | Tratamento                                                                                                   |
| ------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Manifesto declara `gitTrackedLogs=false` mas existe log versionável | contradição           | etapa reprova (`failure`) e o pipeline para                                                                  |
| Um `*.log` deixar de ser ignorado (alguém mexe no `.gitignore`)     | contagem ignorada cai | a etapa detecta a mudança de classe e reprova até a política ser reafirmada — **é o comportamento desejado** |
| `git check-ignore` indisponível / fora de repo                      | precondição           | etapa falha alto (`exit` ≠ 0); não há caminho silencioso                                                     |
| Evidência com zero arquivos versionáveis                            | selo vazio            | coberto por `AC-03` (presença obrigatória dos 5 arquivos de metadata)                                        |
