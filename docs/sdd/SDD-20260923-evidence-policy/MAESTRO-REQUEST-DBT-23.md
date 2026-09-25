# Pedido ao MAESTRO — registro de `DBT-23` no registry de dívidas

> **Por que este arquivo existe e não uma linha no registry:** `docs/evidence/agent-state/DEBTS.md`
> declara o **MAESTRO** como escritor (assim como `QUEUE.md`). Um agente **não** edita nenhum dos dois.
> Este pedido é o registro auditável da dívida **fora** do registry, para que ela não dependa de memória
> de agente — que é exatamente a razão de o registry existir.

- **Solicitante:** agente supervisionado, ciclo `SDD-20260923`
- **Data:** 2026-09-23
- **Origem:** `SDD-20260923-evidence-policy`, §"Lacunas declaradas" (`07-evidence.md`)

## Ação requerida do MAESTRO

Avaliar a abertura de **`DBT-23`** com as duas lacunas abaixo (classe: instrumento/higiene; severidade:
baixa), e — se aceita — escrever a linha no `DEBTS.md` com closure test.

### L1 — contagens do manifesto valem "em `measuredAt`", não no fim

- **Defeito:** o manifesto declara `filesTotal`/`logsTotal` medidos **antes** de 3 arquivos criados por
  construção depois da última medição: `evidence-policy-final.status` (fecho da política),
  `evidence-git-checksum.log` (log da verificação do selo) e `manifest.sha256` (selo do próprio
  manifesto).
- **Medição exata (ciclo de `3c088b6`):** `filesTotal` 125 declarado × **128** final; `logsTotal` 32
  declarado × **33** final.
- **Por que não é mentira, mas é imprecisão:** o manifesto carrega `evidence.measuredAt` e a semântica é
  "as of"; ainda assim, o número não é o final.
- **Closure test proposto:** teste que reexecuta a medição após a selagem e asserta que o delta é
  exatamente o conjunto de arquivos criados pelo fechamento — ou implementação que publique um
  `evidence-final-counts.json` e o inclua no selo.

### L2 — `manifest.sha256` fora do selo versionável

- **Defeito:** `manifest.sha256` é criado **depois** do último `generate_git_checksum`, então não
  aparece em `evidence.git.sha256` (está coberto pelo selo integral, que roda depois).
- **Severidade:** baixa — o conteúdo é derivável do `manifest.json`, que **está** no selo versionável.
- **Closure test proposto:** assertar que todo arquivo versionável do diretório aparece no selo
  versionável, com lista explícita e declarada das exclusões por construção (hoje: apenas o próprio
  `evidence.git.sha256`).

## Estado anterior (registrado em 2026-09-23)

L1 e L2 descritas como **abertas**, com closure test **proposto** e sem implementação — a correção era
escopo do `SDD-20260923-local-ci-hardening` (item 5), que **aguardava aprovação**.

## Implementação no Item 5 (2026-09-24) — **ambas implementadas e verificadas**

### L1 — contagens: cross-check que FALHA na divergência, e a causa raiz fechada

- **Arquivo:** `scripts/local-ci.sh` — `verify_git_checksum()` (o cross-check) e
  `close_evidence_policy()` (a ordem de escrita que fecha a causa raiz).
- **Commits:** cross-check em **`caddf97`**; correção da causa raiz em **`1cf2bc3`**.
- **O que passou a valer:** `linhas(evidence.git.sha256) == manifest.evidence.filesGitTrackable − 1`
  (o selo exclui a si mesmo). Divergência **rebaixa o veredicto**, não vira aviso.
- **Causa raiz fechada, não tolerada:** o `evidence-policy-final.status` era escrito **depois** da
  última medição, então ele próprio (arquivo versionável) ficava fora da contagem declarada — o delta
  de 3 arquivos descrito acima. Agora o status é escrito **antes** da medição final, que passou a ser a
  **última escrita** no diretório.
- **Controle negativo (a asserção não é vacuosa):** ela **já disparou** sobre uma divergência real —
  `docs/evidence/local-ci/1b54a89c3fe9d4489828bafdbe98eee30e28f2b8/evidence-git-checksum.log`:
  `VIOLACAO: selo versionavel cobre 91 arquivo(s), mas o manifesto declara 91 versionaveis`. Foi esse
  disparo que expôs a causa raiz.
- **Evidência da invariante valendo:** `docs/evidence/local-ci/1cf2bc350a688232bedfdfbf99f1e1efbd4512e5/`
  — selo com **92 linhas** × manifesto declarando **93** ⇒ `92 = 93 − 1`.
- **Teste:** **não existe teste unitário** para L1 — a verificação é a **asserção do próprio
  instrumento** executada a cada rodada, mais o disparo registrado acima. Declarado como limite, sem
  inventar caminho de teste.

### L2 — `manifest.sha256` **dentro** do selo versionável

- **Arquivo:** `scripts/local-ci.sh` — `finalize` (escreve `manifest.sha256` com o conteúdo **final**
  antes de regerar o selo versionável) e `close_evidence_policy()` (estabiliza o **conjunto** de
  arquivos antes de medir).
- **Commit:** **`caddf97`**.
- **Como a circularidade foi resolvida:** o selo do manifesto precisa do manifesto final, e o selo
  versionável precisa cobrir o selo do manifesto. A ordem passou a ser: estabilizar o conjunto →
  medir → gerar o selo → escrever o manifesto final → **reescrever `manifest.sha256`** → **regerar** o
  selo versionável (mesmo conjunto, conteúdo novo). Sem auto-hash: `evidence.git.sha256` é excluído da
  própria listagem por `:(exclude)`.
- **Evidência:** no commit selado, `grep -c 'manifest.sha256' …/evidence.git.sha256` = **1**, e a
  verificação em **clone limpo** conferiu **92/92** arquivos, com **0** `.log`, **0** `.bundle` e
  **0** `.patch` exigidos.
- **Teste:** **não existe teste unitário** para L2; a verificação é (a) a asserção de presença em
  `verify_git_checksum` (que exige `manifest.json`, **`manifest.sha256`**, `REPORT.md` e os `.tsv`) e
  (b) a conferência do selo em clone limpo. Declarado como limite.

## Pedido ao MAESTRO

1. **Revisar a implementação de L1 e L2** acima e decidir sobre o **fechamento de `DBT-23`** — ou sobre
   sua reescrita, se o registry preferir registrar a dívida pelo que ela **era** e fechá-la com o
   closure test agora existente.
2. **Se aceito, escrever a linha no `DEBTS.md`** (o agente não escreve no registry).
3. Se o MAESTRO julgar que a ausência de **teste unitário** para L1/L2 é dívida própria, ela deve ser
   registrada como item novo — **não** como parte de DBT-23, cujo defeito está corrigido.

## Contexto que o MAESTRO deve considerar

- Ambas foram encontradas **pelo próprio instrumento** durante o ciclo, não por auditoria externa.
- Ambas estão declaradas em `docs/sdd/SDD-20260923-evidence-policy/07-evidence.md` e no journal (`L160`).
- **Atualização de 2026-09-24:** a correção **deixou de aguardar aprovação** — o `SDD-20260923-local-ci-hardening`
  (item 5) foi aprovado sob `APPROVE_ITEM_5=yes` e **implementou as duas**; ver as seções acima. Este
  pedido deixa de ser "abrir DBT-23" e passa a ser "revisar e fechar DBT-23".
- **Um achado que vale registrar:** a imprecisão L1 ficou **um ciclo inteiro** declarada como prosa
  ("as contagens valem em `measuredAt`") e só foi corrigida quando virou **falha de gate**. O padrão
  generaliza: _declarar uma imprecisão não a corrige; transformá-la em asserção sim._

## O que este pedido **não** pede

- Não pede alteração de `.gitignore` (política `full-logs` continua **não aprovada**).
- Não pede push, billing, status no GitHub ou visibilidade de repositório.
- Não pede fechamento de DBT-19 — esse é objeto de `ADR-030`, com pedido de aprovação separado.
