# 07 — Evidência · SDD-20260923-evidence-policy

## Aceite × medido

| AC        | Critério                                                | Comando                                                                                                          | Resultado                                                                           |
| --------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **AC-01** | política declarada no manifesto                         | `node -e …manifest.evidence…`                                                                                    | `policy=metadata-only`, `gitTrackedLogs=false`, `localLogsAvailable=true`           |
| **AC-02** | selo versionável sem logs                               | `grep -cE '\.log$' evidence.git.sha256`                                                                          | **0** (de 85 linhas)                                                                |
| **AC-03** | selo versionável cobre o metadata                       | `grep -E '/(manifest\.json\|REPORT\.md\|steps\.tsv\|adaptations\.tsv\|pendencies\.tsv\|evidence-counts\.json)$'` | **6/6 presentes**                                                                   |
| **AC-04** | etapa de verificação passa no pipeline                  | `steps.tsv`                                                                                                      | `evidence-policy-check  success`                                                    |
| **AC-05** | **controle negativo** — a etapa reprova sob contradição | `/tmp/evidence-policy-negative-control.sh`                                                                       | **`casos OK: 6 \| casos FALHOS: 0`**                                                |
| **AC-06** | contagens do manifesto conferem com o mundo             | `find` × `manifest.evidence`                                                                                     | **exatas em `measuredAt`**; delta de 3 arquivos posterior à medição, nomeado abaixo |
| **AC-07** | `.gitignore` intocado                                   | `git diff --name-only 3c088b6^ 3c088b6 -- .gitignore`                                                            | **vazio**                                                                           |
| **AC-08** | bundle/patches declarados `local-only`                  | `manifest.artifacts.bundlePolicy`                                                                                | `local-only (nunca versionado: artifacts/ e ignorado pelo .gitignore)`              |
| **AC-09** | selo integral preservado                                | `sha256sum -c 3c088b6….sha256`                                                                                   | **128/128 SUCESSO**                                                                 |

## Controle negativo (AC-05) — o resultado que importa

Executado em fixture de git isolado (`mktemp`), com a função **real** extraída de `scripts/local-ci.sh`
(por `awk` com terminador explícito — nunca uma cópia da lógica), e `.gitignore` **sem** `*.log`, para
que a regra seja falsificável:

| Caso | Cenário                                | Esperado | Obtido                                                                               |
| ---- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| C1   | só metadata                            | 0        | **0**                                                                                |
| C2   | `*.log` versionável                    | 1        | **1** (`VIOLACAO: 1 arquivo(s) *.log seriam versionados sob politica metadata-only`) |
| C3   | bundle **fora** de `artifacts/`        | 1        | **1** (`VIOLACAO: 1 artefato(s) de preservacao seriam versionados`)                  |
| C4   | patch **fora** de `artifacts/`         | 1        | **1**                                                                                |
| C5   | bundle **sob** `artifacts/` (ignorado) | 0        | **0**                                                                                |
| C6   | árvore vazia (precondição)             | 2        | **2** (`precondicao: arvore de evidencia vazia`)                                     |

Sem este controle, o `AC-01` seria vácuo: no repositório real `*.log` é ignorado globalmente, então a
regra de log **nunca** dispararia sem alguém mexer no `.gitignore`.

## Dois defeitos encontrados pelo próprio instrumento (corrigidos antes do commit)

1. **Porta fail-open na classificação.** A primeira versão lia um `git check-ignore` **quebrado**
   (status ≥ 2) como "nada ignorado". Corrigido: qualquer status ≠ 0/1 é **precondição** (exit 2).
2. **Regra de artefato cega fora de `artifacts/`.** A primeira versão classificava preservação apenas
   por diretório, então um bundle largado na raiz da evidência — versionável — **escapava**. Passou a
   classificar por **nome/conteúdo** (`local-commits-*.bundle`, `*.patch`). Os casos C3/C4 existem
   exatamente por causa desse defeito.

## Verificação em clone limpo (o problema original, testado de ponta a ponta)

```text
git clone --no-hardlinks . /tmp/clean-clone
cd /tmp/clean-clone
sha256sum -c docs/evidence/local-ci/3c088b6…/evidence.git.sha256   →  85/85 SUCESSO
find … -name '*.log' | wc -l    → 0
find … -name '*.bundle' | wc -l → 0
find … -name '*.patch' | wc -l  → 0
```

O selo versionável **verifica no clone** — que é precisamente o que a receita ingênua
(`git ls-files` puro, sobre evidência ainda _untracked_) não conseguiria produzir.

## Lacunas declaradas (não escondidas)

- **L1 — as contagens do manifesto são "em `measuredAt`", não finais.** Delta exato de **3 arquivos**
  criados depois da última medição, por construção: `evidence-policy-final.status` (fecho da política),
  `evidence-git-checksum.log` (log da verificação do selo) e `manifest.sha256` (selo do próprio
  manifesto). Declarado: `filesTotal=125` medido × `128` final; `logsTotal=32` × `33`. Correção
  proposta no `SDD-20260923-local-ci-hardening` (re-medir após a selagem e publicar as contagens
  finais num arquivo próprio, ou declarar o delta no manifesto).
- **L2 — `manifest.sha256` não está no selo versionável.** É criado **depois** do último
  `generate_git_checksum` (e antes do selo integral, que o cobre). Severidade baixa: seu conteúdo é
  derivável do `manifest.json`, que **está** no selo versionável.
- **L3 — os `steps[].log` citados pelo manifesto não existem no clone.** É a consequência **declarada**
  e aceita da política `metadata-only` (`gitTrackedLogs=false`, `localLogsAvailable=true`): antes do
  ciclo a contradição era **silenciosa**; agora é **declarada** e com contagem publicada.
- **L4 — a evidência de `8683c2d` continua local** (layout anterior à política; o `preservation/` dela
  não é ignorado pelo Git, então um `git add` do diretório arrastaria bundle e patches). Decisão
  declarada, não esquecimento.

## Registro da dívida

As lacunas **L1/L2** são dívida de instrumento. O registry de dívidas
(`docs/evidence/agent-state/DEBTS.md`) tem o **MAESTRO como escritor**, portanto **este ciclo não
escreveu nele** — abrir `DBT-23` para elas é **ação humana**, declarada em `docs/TODO.md`.
