# 01 — SPEC · SDD-20260923-evidence-policy

- **ID:** `SDD-20260923-evidence-policy`
- **Status:** `EXECUTADO` (execução registrada em `07-evidence.md` e `08-report.md`)
- **Data:** 2026-09-23
- **Dono:** agente supervisionado

## 1. Problema

O pipeline local supervisionado produz **119 arquivos** de evidência em
`docs/evidence/local-ci/<sha>/`, e o `.gitignore` do repositório ignora `*.log` globalmente. Medição:

```text
arquivos: 119   |   ignorados pelo git (padrao *.log): 58   |   versionáveis: 61
```

Consequência: um `git add docs/evidence/local-ci/<sha>` versionaria o `manifest.json` — que referencia
**cada** log por nome (`steps[].log`) — sem versionar **nenhum** dos 58 logs. O artefato commitado
apontaria para arquivos ausentes do próprio commit. Isso é uma contradição silenciosa: o manifesto
afirma uma estrutura de evidência que o Git não carrega.

Agravante: o bloco de artefatos do manifesto também cita `preservation/` (bundle + 6 patches), que a
política não quer versionar (artefatos binários/serializados, regeneráveis a partir dos commits).

## 2. Contexto

- O repositório já tem precedente de evidência **selada e não reformatada** (`docs/evidence/security-scan/**`,
  `docs/evidence/*/playwright-mcp*/**` em `.prettierignore`) — mas **não** tem precedente de política de
  versionamento de log.
- `m02:secrets-audit` **exclui** `docs/evidence/` por construção (`path.startsWith("docs/evidence/")`),
  então a árvore de evidência não é varrida por ele; a varredura de segredo da evidência é
  responsabilidade do próprio `local-ci` (`range-secret-scan`).
- O usuário definiu a política padrão recomendada: **`metadata-only`** — commitar apenas metadata
  confiável; não commitar `*.log`, bundle nem patches sem aprovação.

## 3. Objetivo

Tornar a evidência **coerente com o que o Git realmente versiona**: declarar a política no manifesto,
produzir um selo restrito ao conjunto versionável e **verificar** que nenhum log referenciado está
sendo tratado como versionado.

## 4. Não objetivos

- **Não** alterar `.gitignore` para permitir logs (`full-logs`). É mudança de política do repositório e
  exige aprovação humana explícita (§9.9 do contrato).
- **Não** commitar bundle nem patches.
- **Não** remover os logs locais: eles continuam existindo e disponíveis na máquina.
- **Não** enfraquecer o selo integral existente (`<sha>.sha256`), que continua cobrindo **todos** os 119
  arquivos — é o que dá integridade local.

## 5. Restrições

- `metadata-only` é o padrão; qualquer mudança de política é ato humano.
- Nenhum segredo em artefato versionado.
- O manifesto não pode mentir: se a política for `metadata-only`, o campo `gitTrackedLogs` tem de ser
  `false` e isso tem de ser **verificável**.

## 6. Requisitos

- **REQ-01** — o manifesto declara `evidence.policy` (`metadata-only`), `gitTrackedLogs` (`false`),
  `localLogsAvailable` (`true`) e as contagens de arquivos totais / versionáveis / ignorados.
- **REQ-02** — é gerado `evidence.git.sha256` cobrindo **apenas** o conjunto que o Git versiona
  (`git ls-files --cached --others --exclude-standard`), isto é, excluindo o que é ignorado.
- **REQ-03** — o `local-ci` **verifica** a política e falha alto se houver contradição: um arquivo que o
  manifesto trate como versionado e o Git ignore (ou o inverso).
- **REQ-04** — `metadata-only` **não** pode esconder os logs: a contagem de ignorados é publicada no
  manifesto e os logs permanecem no diretório selado pelo selo integral.
- **REQ-05** — bundle e patches são declarados como **não versionados por política**, com o caminho
  registrado para uso local.
- **REQ-06** — nenhuma mudança em `.gitignore` neste ciclo.

## 7. Critérios de aceite

Ver `02-acceptance.md`.

## 8. Plano de teste

1. `./scripts/local-ci.sh` ⇒ nova etapa `evidence-policy-check` = `success`.
2. `manifest.json` contém o objeto `evidence` com as contagens e a política.
3. `evidence.git.sha256` existe e **não** contém nenhuma linha `*.log`.
4. Controle negativo: injetar um arquivo que contradiga a política e verificar que a etapa **reprova**.
5. `git check-ignore` confirma que os 58 logs seguem ignorados (a política descreve o mundo, não o força).

## 9. Plano de reversão

Reverter o commit do `scripts/local-ci.sh`. A árvore de evidência continua válida (o selo integral não
depende da política); apenas o bloco `evidence` e o arquivo `evidence.git.sha256` deixam de ser gerados.

## 10. Riscos

Ver `05-risk.md`.

## 11. Dependências

- Nenhuma de rede/plataforma. Depende apenas de `git ls-files`/`git check-ignore` (locais).

## 12. Aprovações necessárias

- **Nenhuma** para implementar `metadata-only` (é o padrão recomendado).
- **Humana explícita** para migrar para `full-logs` (exceção no `.gitignore` + revisão de segredos).
