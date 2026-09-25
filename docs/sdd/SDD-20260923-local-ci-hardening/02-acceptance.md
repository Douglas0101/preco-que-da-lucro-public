# 02 — Critérios de aceite · SDD-20260923-local-ci-hardening

Os 14 critérios são os do despacho de aprovação (`APPROVE_ITEM_5=yes`). **Estado medido** ao lado de cada um.

| #         | Critério                                                    | Verificação                                                                                       | Estado                                                   |
| --------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **AC-01** | Secret-audit continua detectando segredo real               | `src/test/local-ci-secret-scan.test.ts` N1–N4 (ghp_, PRIVATE KEY, AKIA, xox)                      | **✅** 4/4 hits                                          |
| **AC-02** | Ruído loopback documentado reduzido por allowlist declarada | classificação do range real: `total=12 permitidos=12 hits=0`                                      | **✅** ids `AL-01:6, AL-02:3, AL-03:1, AL-04:1, AL-05:1` |
| **AC-03** | Allowlist com testes negativos                              | 10 casos (N1–N10) em `npm run test`                                                               | **✅** 10/10                                             |
| **AC-04** | Manifesto declara `measuredAt`                              | `manifest.evidence.measuredAt` + `countsAreSnapshotAt`                                            | **✅**                                                   |
| **AC-05** | Contagens reproduzíveis                                     | `verify_git_checksum` asserta `linhas(evidence.git.sha256) == filesGitTrackable − 1`              | **✅** cross-check no pipeline                           |
| **AC-06** | `manifest.sha256` no selo versionável                       | `grep manifest.sha256 evidence.git.sha256`                                                        | **✅** (era a lacuna L2)                                 |
| **AC-07** | Selagem recusa árvore suja fora da evidência                | `./scripts/local-ci.sh` com árvore suja ⇒ **exit 2**                                              | **✅** medido 2×                                         |
| **AC-08** | Escape `LOCAL_CI_ALLOW_DIRTY=1` testado e registrado        | `manifest.evidence.treeState/dirtyEscapeUsed/headShaCorrespondsToContent` + **pendência nominal** | **✅**                                                   |
| **AC-09** | Nenhum gate novo criado                                     | `git diff` não toca `package.json` (cadeia) nem workflows                                         | **✅**                                                   |
| **AC-10** | Nenhum contrato de CI alterado                              | idem; `AGENTS.md` intocado neste ciclo                                                            | **✅**                                                   |
| **AC-11** | `local-ci` completo passa no novo HEAD                      | `verdict=success` em `caddf97`                                                                    | ver `07-evidence.md`                                     |
| **AC-12** | Evidência metadata-only verifica em clone limpo             | `sha256sum -c evidence.git.sha256` no clone                                                       | ver `07-evidence.md`                                     |
| **AC-13** | Journal atualizado                                          | `L167` (`▶`) / `L168` (`✔`)                                                                       | **✅**                                                   |
| **AC-14** | Nenhum push realizado                                       | `origin/develop` = `a2f5ff6`                                                                      | **✅**                                                   |

## Regra anti-vacuidade

- **AC-01 e AC-03 são conjuntivos com AC-02:** reduzir ruído sem prova de que a detecção continua é o
  caminho mais curto para um scanner decorativo. Os casos N1–N4 provam a detecção; N5–N7 provam que a
  supressão é **escopada**; **N8 prova que a supressão não engole um segredo real na mesma linha**.
- **AC-05 é igualdade, não aproximação.** Contagem declarada e conteúdo do selo divergirem é a mesma
  classe de defeito que a evidência mal-rotulada deste ciclo.
- **AC-07/AC-08 são medidos contra a árvore real suja**, não contra fixture — foi assim que o mislabel
  apareceu.
- **AC-09/AC-10 são verificados por `git diff --name-only`**, não por prosa.
