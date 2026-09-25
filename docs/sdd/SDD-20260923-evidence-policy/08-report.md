# 08 — Relatório · SDD-20260923-evidence-policy

## Veredicto

**`EXECUTADO` — objetivo cumprido, com lacunas declaradas.** A evidência agora é **coerente com o que
o Git versiona**: a política é declarada, o conjunto versionável tem selo próprio que verifica em
clone limpo, e a verificação é **falsificável** (6 casos de controle negativo, 0 falhas).

## O que mudou

| Antes                                                                   | Depois                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.json` citava 58 `*.log` que o Git ignorava, sem declarar nada | política `metadata-only` declarada, `gitTrackedLogs=false` **derivado**, `localLogsAvailable=true`, contagens **medidas** publicadas |
| um `git add` do diretório contradizia o próprio manifesto               | o conjunto commitado **é** o conjunto selado por `evidence.git.sha256` (85 arquivos)                                                 |
| bundle e patches ficavam versionáveis (em `preservation/`)              | movidos para `artifacts/`, que o **`.gitignore` do próprio repo** já exclui                                                          |
| nenhuma verificação de política                                         | etapa `evidence-policy-check` **fail-closed**, com 6 casos de falsificação                                                           |
| selo único (tudo)                                                       | **dois** selos: integral (128 arquivos, local) e versionável (85, verificável em clone)                                              |

## Decisão de integridade que vale registrar

O enunciado sugeria versionar apenas cinco arquivos de metadata. Isso foi **rejeitado de propósito**:
comitar só os cinco deixaria `evidence.git.sha256` (85 entradas) apontando para **80 arquivos
ausentes** — exatamente a contradição que este SDD existe para remover. O conjunto commitado passou a
ser **idêntico** ao conjunto selado, e o custo disso é medido: **376 KB** em 87 arquivos, todos
metadata (nenhum log, nenhum bundle, nenhum patch).

## Custo

- 1 alteração de script (`scripts/local-ci.sh`) + 1 execução completa (**311 s**).
- 1 commit de evidência (`86565f0`), nenhum push.

## Riscos que viraram fato ou que seguem abertos

- `RISK-03` (verificador decorativo) — **materializado no primeiro esboço e fechado** pelo controle
  negativo; os dois defeitos do instrumento (§"dois defeitos" no `07-evidence.md`) foram achados por
  ele mesmo.
- `RISK-08` (repositório sem os logs) — **aceito conscientemente** e declarado em L3.
- `RISK-05` (commit citando ausente) — **fechado para o conjunto versionável** (clone limpo 85/85);
  segue **declarado** para os logs (L3).

## Reversão

`git revert 86565f0` (evidência + marcador) e, se aplicável, `git revert 3c088b6` (script). O selo
integral e os logs permanecem no disco local em qualquer cenário.
