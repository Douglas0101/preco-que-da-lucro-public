# 03 — Design · SDD-20260923-local-ci-hardening

## 1. Precisão de alvo que mudou a implementação

O despacho pediu "redução de ruído do **secret-audit**". Medição: o `m02:secrets-audit` (a guarda)
tem **0** literais na árvore real e **não possui** padrão de URL postgres. Os 7 (hoje 12) hits vêm do
**`range-secret-scan` do `local-ci`** — outro instrumento, com outro propósito (varrer o _range_ de
commits, não a árvore). A allowlist foi aplicada **no instrumento que produz o ruído**; mexer no
`m02:secrets-audit` teria sido alterar a guarda errada.

## 2. Allowlist declarada (A)

**Forma:** `scripts/local-ci-secret-allowlist.json` — dados, não código. Cada entrada tem
`id · pattern (literal) · scope (arquivo ou diretório) · reason · decidedAt · decidedBy · negativeTest`.

**Por que literal e não regex:** o padrão é comparado como **substring exata** (`content.includes`).
Regex na allowlist seria uma segunda linguagem de padrões para auditar — e a fonte clássica de
supressão acidental.

**Por que escopo por arquivo:** a mesma string em outro arquivo volta a ser hit (N6). A lista não pode
ser global; uma ocorrência nova exige entrada nova, declarada.

**Minimalidade:** 5 entradas, **todas usadas** (`AL-01:6, AL-02:3, AL-03:1, AL-04:1, AL-05:1` = 12/12).
Duas entradas escritas por precaução casaram **zero** vezes e foram **podadas** — allowlist acumulada
é allowlist que ninguém revisa.

## 3. Classificador extraído e testável

`scripts/local-ci-secret-scan.mjs` — o pipeline deixou de ter a lógica inline (`git grep | cut`), que
não era testável. O módulo:

1. lê `<rev>:<path>:<linha>:<conteúdo>` do stdin;
2. avalia **`HARD_PATTERNS` primeiro** (chave privada, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`,
   `sk-proj-`, `xox[baprs]-`, `AKIA`, JWT-like);
3. só então a allowlist;
4. escreve **apenas** `arquivo:linha` (stdout) e um resumo de contagens (stderr) — **nunca** o conteúdo.

**A ordem é a defesa central:** se a allowlist fosse avaliada primeiro, uma linha contendo a credencial
permitida **e** um token real seria suprimida inteira. N8 fixa esse contrato.

**Fail-closed na estrutura:** entrada sem campo obrigatório, padrão vazio ou id duplicado ⇒ **exit 2**
(precondição), que o pipeline converte em parada. Allowlist ilegível nunca vira "nada encontrado" (N9).

## 4. Teste de vivacidade — o fail-open que este ciclo introduziu e fechou

A primeira versão do padrão amplo usou `\b` e `(?:...)`. **`git grep -E` é POSIX ERE e não suporta
nenhum dos dois** — o padrão casou **zero** linhas e o resumo saiu `total=0`, **indistinguível de
"limpo"**. Corrigido em dois níveis:

1. padrão reescrito em ERE estrito (`(...)` em vez de `(?:...)`, sem `\b`);
2. **teste de vivacidade obrigatório no pipeline**: antes de varrer, o padrão precisa casar uma amostra
   sintética de **cada** família (5 probes). Se não casar, a rodada **para** com precondição.

Detector que não detecta é pior do que nenhum: ele produz um verde que ninguém questiona.

## 5. Manifesto: fotografia temporal declarada (B)

Campos novos em `manifest.evidence`:

| Campo                                                | Significado                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `measuredAt` / `countsAreSnapshotAt`                 | as contagens valem **naquele instante**, declarado como tal                  |
| `filesTotal`, `filesGitTrackable`, `filesGitIgnored` | classes principais                                                           |
| `logsTotal`, `logsGitIgnored`                        | logs locais                                                                  |
| `artifactsTotal`, `artifactsGitIgnored`              | preservação (bundle/patches)                                                 |
| `filesIgnoredOther`                                  | ignorados **fora** de log/artefato — > 0 ⇒ surgiu classe nova sem declaração |
| `treeState`                                          | `clean` ou `dirty-escaped`                                                   |
| `dirtyEscapeUsed`, `dirtyEntriesOutsideEvidence`     | uso do escape, declarado                                                     |
| `headShaCorrespondsToContent`                        | **`false` quando o escape foi usado** — a divergência não é silenciada       |

**Cross-check (AC-05):** `verify_git_checksum` asserta `linhas(evidence.git.sha256) == filesGitTrackable − 1`
(o selo exclui a si mesmo). Divergência rebaixa o veredicto.

## 6. `manifest.sha256` dentro do selo versionável (C)

O obstáculo é circularidade: o selo do manifesto precisa do manifesto **final**, e o selo versionável
precisa cobrir o selo do manifesto. Resolvido por **estabilização do conjunto antes da medição**:

1. `manifest.sha256` é criado (placeholder) **antes** de medir ⇒ o _conjunto de arquivos_ já o inclui;
2. mede-se (C1) e gera-se o selo versionável;
3. mede-se de novo (C2) — conjunto estável;
4. o manifesto final é escrito com C2;
5. `manifest.sha256` recebe o **conteúdo final**;
6. o selo versionável é **regerado** (mesmo conjunto, conteúdo novo) ⇒ cobre `manifest.json` **e**
   `manifest.sha256`;
7. o selo integral (que roda por último) cobre o próprio selo versionável.

Nenhum auto-hash: `evidence.git.sha256` é excluído da própria listagem por `:(exclude)`.

## 7. Escape de árvore suja (D)

Recusa por **exit 2** quando há entrada suja fora de `docs/evidence/local-ci/`. Com
`LOCAL_CI_ALLOW_DIRTY=1`: a rodada segue, mas grava `tree-state.txt`, o manifesto declara
`dirtyEscapeUsed: true` e `headShaCorrespondsToContent: false`, e uma **pendência nominal** entra em
`pendencies.tsv`. O escape **não pode** silenciar a divergência — é o oposto: ele a publica.

## 8. Diagnóstico de e2e (E) e worktrees (F)

- **E:** em falha de e2e, `test-results/` e `playwright-report/` (trace, screenshot, vídeo,
  error-context) são copiados para `<evidência>/artifacts/e2e-diagnostics/` — gitignored, local, e o que
  permite investigar em vez de especular. **Nenhum retry automático** foi adicionado:
  `E2E_FLAKE_DECISION=known-limitation`.
- **F:** inventário em `docs/evidence/local-ci/_ops/artifacts/worktree-inventory.md`. O caminho
  sugerido (`docs/ops/`) foi **desviado por necessidade medida**: um arquivo não versionado fora da
  árvore de evidência faria a precondição de árvore suja **recusar a selagem**. Sob `artifacts/` ele
  fica local (o `.gitignore` do repo já exclui `docs/evidence/**/artifacts/`) e fora do `format:check`.
  **Nenhuma remoção.**

## 9. Casos de falha

| Caso                                     | Tratamento                                           |
| ---------------------------------------- | ---------------------------------------------------- |
| Allowlist ilegível/inválida              | exit 2 de precondição (N9) — nunca "nada encontrado" |
| Padrão deixa de casar (regressão de ERE) | teste de vivacidade para a rodada                    |
| Nova ocorrência em arquivo não listado   | volta a ser hit — comportamento desejado             |
| Entrada de allowlist sem uso             | podada (minimalidade)                                |
| Contagem declarada ≠ selo                | `verify_git_checksum` reprova                        |
| Escape usado                             | declarado + pendência nominal                        |
