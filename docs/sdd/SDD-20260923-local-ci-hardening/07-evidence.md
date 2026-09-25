# 07 — Evidência · SDD-20260923-local-ci-hardening

## Aceite × medido

| #         | Critério                              | Medição                                                                           | Estado                                               |
| --------- | ------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **AC-01** | detecção real preservada              | N1–N4 (ghp_, PRIVATE KEY, AKIA, xox)                                              | ✅ 4/4                                               |
| **AC-02** | ruído loopback reduzido               | `total=14 permitidos=12 autodeclarados=2 hits=0`                                  | ✅ ids `AL-01:6, AL-02:3, AL-03:1, AL-04:1, AL-05:1` |
| **AC-03** | allowlist com casos negativos         | `src/test/local-ci-secret-scan.test.ts`                                           | ✅ **12/12** (N1–N12)                                |
| **AC-04** | manifesto declara `measuredAt`        | `evidence.measuredAt` + `countsAreSnapshotAt`                                     | ✅ `2026-09-24T03:46:35.424Z`                        |
| **AC-05** | contagens reproduzíveis               | selo **92** linhas × declarado **93** ⇒ `92 = 93 − 1`                             | ✅ cross-check passa                                 |
| **AC-06** | `manifest.sha256` no selo versionável | `grep -c manifest.sha256 evidence.git.sha256`                                     | ✅ **1** (era a lacuna L2)                           |
| **AC-07** | recusa árvore suja                    | `./scripts/local-ci.sh` com árvore suja ⇒ **exit 2**                              | ✅ medido 3×                                         |
| **AC-08** | escape testado e registrado           | `treeState`, `dirtyEscapeUsed`, `headShaCorrespondsToContent` + pendência nominal | ✅ `clean` / `false` / `true`                        |
| **AC-09** | nenhum gate novo                      | `git diff --name-only` em `package.json`/workflows                                | ✅ 0                                                 |
| **AC-10** | nenhum contrato alterado              | idem; `AGENTS.md` intocado neste ciclo                                            | ✅ 0                                                 |
| **AC-11** | `local-ci` completo verde             | `veredicto=success`, **341 s**, exit **0**                                        | ✅                                                   |
| **AC-12** | selo verifica em clone limpo          | `sha256sum -c` no clone                                                           | ✅ ver `08-report.md`                                |
| **AC-13** | journal atualizado                    | `L167` (`▶`) / `L168` (`✔`)                                                       | ✅                                                   |
| **AC-14** | nenhum push                           | `origin/develop` = `a2f5ff6`                                                      | ✅                                                   |

## Estado medido do commit selado `1cf2bc3`

```text
result=success  duracao=341s  pendencies=[]  coverage=true
policy=metadata-only  gitTrackedLogs=false  treeState=clean  headShaCorrespondsToContent=true
filesTotal=143  filesGitTrackable=93  logsTotal=31  artifactsTotal=19  filesIgnoredOther=0
security: pushPerformed=false  billingChanges=false  remoteMutations=false
```

Tier de banco **executado** (o diff toca `scripts/**` ⇒ `db=true`) e verde em 27 s; e2e chromium+mobile
verde em 62 s; scan de segredo com **0 hits** e 12 supressões declaradas + 2 autodeclarações.

## As quatro voltas do ciclo — o que cada uma ensinou

| Volta | Sintoma                                                 | Causa                                                                     | Correção                                                                                                   |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1     | `total=0` no scan                                       | `\b` e `(?:...)` não existem em POSIX ERE                                 | padrão em ERE estrito **+ teste de vivacidade**                                                            |
| 2     | `m02:secrets-audit` reprovou                            | o probe de vivacidade continha um `ghp_…` **literal**                     | probes e fixtures montados em runtime; autodeclaração isenta por código (N11 garante que não é ponto cego) |
| 3     | `check-chain` vermelho em `format:check`                | arquivos do SDD escritos **durante** a rodada                             | checagem de **deriva de estado** no `finalize` (HEAD + sujeira, início × fim)                              |
| 4     | veredicto `failure` com exit **0** e mensagem `success` | `finalize` rebaixava `RESULT` mas a mensagem era fixa e o exit não seguia | mensagem e exit code passam a refletir o veredicto real                                                    |

E uma quinta, **ambiental**: o cross-check de contagens acusou `cobre 91 × declara 91` — o **selo estava
certo** e o declarado ficava 1 abaixo porque `evidence-policy-final.status` era escrito depois da última
medição. Era a imprecisão **L1** do ciclo anterior, convertida de prosa em **falha de gate**. Fechada na
raiz: o status do fecho passou a ser escrito **antes** da medição final, que virou a última escrita.

## Falha não reproduzida, com causa provável declarada

Uma rodada falhou em `format:check` acusando `EXECUTION-STATE-PROGRAM.md`, com o arquivo
**comprovadamente** limpo (mtime anterior à rodada, `prettier --check` limpo antes e depois, `git diff`
vazio, `tree-state: clean`, `pendencies: 0`). Não foi reproduzida em três tentativas, incluindo a
sequência exata (`npm ci --ignore-scripts && npm run format:check`). **Causa provável declarada:** a
máquina local entrou em **pressão de memória e congelou (OOM)**, exigindo reinício bruto — o evento
interrompeu uma rodada em andamento e é compatível com comportamento errático de processos sob memória.
O **mesmo commit** passou depois do reinício (341 s, exit 0). Registrado como não reproduzido, **não**
como lenda e **não** como defeito de código.

## Reconciliação pós-reinício (protocolo de boot)

Antes de qualquer reexecução: `git fsck` limpo, sem locks, árvore limpa fora da evidência, HEAD
`1cf2bc3` intacto; instrumentos íntegros (`bash -n`, JSON válido, `node --check`, prettier limpo); **sem
containers residuais**. Dois resíduos **sem `result.txt`** (não-evidência) foram tratados: o parcial da
rodada interrompida foi arquivado pelo próprio `local-ci` na execução seguinte, e o resíduo estale de
`8683c2d` foi arquivado com `RESIDUO-DECLARADO.md`. Nada foi apagado.
