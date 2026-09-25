# 05 — Riscos · SDD-20260923-local-ci-hardening

| ID          | Risco                                                            | Prob.              | Impacto                                                                               | Mitigação                                                                                                                                                 | Sinal                                                 |
| ----------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **RISK-01** | Allowlist engolir segredo real                                   | média              | perda de detecção — o pior resultado possível, porque fica invisível                  | `HARD_PATTERNS` avaliados **antes**; **N8** fixa o contrato (credencial permitida + token real na mesma linha ⇒ hit); N10 proíbe padrão real na allowlist | N8 ou N10 reprovando                                  |
| **RISK-02** | Allowlist acumular entradas sem uso                              | alta               | lista que ninguém revisa; supressão futura por inércia                                | minimalidade verificada: 2 entradas sem uso foram **podadas**; `maintenance` no JSON declara a regra                                                      | entrada que nunca casa                                |
| **RISK-03** | Padrão de detecção quebrar em silêncio (o fail-open que ocorreu) | **alta (ocorreu)** | `total=0` lido como "limpo"                                                           | **teste de vivacidade** obrigatório: 5 probes, falha ⇒ precondição                                                                                        | `PRECONDICAO: padrao nao casa a amostra`              |
| **RISK-04** | O instrumento carregar os literais que procura (ocorreu)         | **alta (ocorreu)** | `m02:secrets-audit` reprova o próprio instrumento; rodada falha                       | probes e fixtures montados em runtime; isenção por código do arquivo de autodeclaração, com N11 provando que não é ponto cego                             | `possible secret literal at scripts/local-ci.sh`      |
| **RISK-05** | Contagens do manifesto divergirem do selo                        | média              | manifesto afirmando um mundo que o selo desmente                                      | `verify_git_checksum` asserta `linhas == filesGitTrackable − 1`; divergência rebaixa o veredicto                                                          | `VIOLACAO: selo versionavel cobre N`                  |
| **RISK-06** | Escape de árvore suja silenciar divergência de SHA               | média              | evidência rotulada com commit que não contém o conteúdo (o defeito do ciclo anterior) | escape **registrado** no manifesto (`dirtyEscapeUsed`, `headShaCorrespondsToContent: false`) + **pendência nominal**                                      | `treeState: dirty-escaped`                            |
| **RISK-07** | `manifest.sha256` ficar fora do selo (L2)                        | média              | lacuna declarada que volta a crescer                                                  | conjunto estabilizado antes da medição; presença verificada no `verify_git_checksum`                                                                      | `manifest.sha256 ausente do selo versionavel`         |
| **RISK-08** | Isenção do arquivo de autodeclaração virar ponto cego            | baixa              | segredo real escondido no arquivo da allowlist                                        | padrões duros avaliados antes; **N11** fixa o comportamento                                                                                               | N11 reprovando                                        |
| **RISK-09** | Diagnóstico de e2e inflar a evidência                            | baixa              | diretório grande (trace/vídeo)                                                        | copiado **só em falha** e sob `artifacts/` (gitignored, fora do selo versionável)                                                                         | tamanho de `artifacts/`                               |
| **RISK-10** | Worktrees residuais confundirem verificações                     | média              | grep alcança cópias antigas (`.worktree-r3-forensics/`)                               | **inventariadas** em arquivo local, com a recomendação declarada; **nenhuma remoção**                                                                     | verificação que encontra código inexistente na árvore |

## Riscos aceitos conscientemente

**RISK-11 — a allowlist exige manutenção a cada nova superfície.** Uma ocorrência nova em arquivo não
listado **volta a ser hit**. É deliberado: o custo de declarar é o preço de não ter supressão
silenciosa. A alternativa (escopo por diretório amplo) foi rejeitada por ser allowlist de fato global.

**RISK-12 — o e2e continua com `retries: 0` e um transiente pode reprovar a rodada.** Decisão humana
registrada: `E2E_FLAKE_DECISION=known-limitation`. Nenhum retry automático foi adicionado (exigiria
ADR). O que mudou foi a **capacidade de diagnosticar**: em falha, trace, screenshot, vídeo e
error-context são preservados.

## Não-riscos (verificados)

- **Contrato de gate:** nenhum. `package.json` (cadeia), workflows e `AGENTS.md` **intocados** neste
  ciclo — verificado por `git diff --name-only`.
- **Dependências:** nenhuma nova; `package-lock.json` intocado.
- **Rede/plataforma:** o scan e os testes rodam offline.
- **`DEBTS.md`/`QUEUE.md`:** intocados (escritor é o MAESTRO).
