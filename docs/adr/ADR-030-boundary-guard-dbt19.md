# ADR-030 — Boundary guard: encadear `m02:boundaries` e `m02:secrets-audit` num gate (DBT-19)

- **ID:** ADR-030 · **Rastro:** `DBT-19` (`docs/evidence/agent-state/DEBTS.md`) ← achado N7 do S6 do WP-R8 · **Data:** 2026-09-23
- **Estado:** **IMPLEMENTADA (2026-09-24) — ratificação pendente.** O contrato foi aprovado
  (`APPROVE_ADR_030=yes`) e implementado no commit **`c7e6a55`**: `package.json` (cadeia `check` 14→16),
  `.github/workflows/ui-stack.yml` (dois passos diretos), `AGENTS.md` (tabela de cobertura), as duas
  guardas e o closure test. **ERRATA de estado:** até 2026-09-24 esta linha dizia _"PROPOSTA — NÃO
  IMPLEMENTADA … Nenhuma linha de `package.json`, `npm run check`, workflow ou registry foi alterada por
  este ADR"_ — o que passou a ser **falso** quando o commit foi feito. O cabeçalho não foi atualizado
  junto (defeito meu, apontado por auditoria independente em 2026-09-24) e ficou contradizendo o próprio
  repositório. O corpo abaixo é preservado como registro do que foi **proposto**; o que foi **feito**
  está em §9 (errata) e em `docs/sdd/SDD-20260923-boundary-guard-dbt19/08-report.md`.
  **`DBT-19` NÃO está fechada:** a condição do registry exige, além do caso negativo, que a tabela do
  `AGENTS.md` bata com os YAMLs **por asserção de teste** — e essa asserção **não existe** (ver §9.3).
- **Tipo:** contrato de CI (cobertura de gates)
- **Precedente de forma:** ADR-029 (proposta/draft com implementação pendente de ratificação); `AGENTS.md` § Local quality gate (tabela de cobertura por pipeline)

## 1. Fato

1. **DBT-19 (verbatim do registry):** _"dois guards declarados contrato não rodam em push de código:
   `m02:boundaries` não aparece em `check`, no `verify` do `ui-stack` nem na light (verde medido à mão em
   2026-09-22: 'M-02 BFF boundary is clean'), e `m02:secrets-audit` só roda na light — um push só de
   código nunca o executa. Fechada quando ambos aparecem no encadeamento de um pipeline **com um caso
   negativo que os falsifica** (guard que nunca reprova não é guard) e a tabela de cobertura do
   `AGENTS.md` bate com os YAMLs por asserção de teste."_
2. **Cobertura por push de código medida na tabela do `AGENTS.md`:** `m02:secrets-audit` tem `✔` só na
   coluna light; `m02:boundaries` tem `✘` nas **três** colunas (`check`, heavy, light). A interseção de
   cobertura dos dois, num push só de código, é **vazia**.
3. **Custo medido nesta rodada (3 execuções cada, nesta máquina):**

   | Guarda              |  exec 1 |  exec 2 |  exec 3 |       média |    pior |
   | ------------------- | ------: | ------: | ------: | ----------: | ------: |
   | `m02:boundaries`    |  240 ms |  204 ms |  197 ms |  **213 ms** |  240 ms |
   | `m02:secrets-audit` | 1781 ms | 1802 ms | 1828 ms | **1803 ms** | 1828 ms |

   Total que entraria na cadeia: **≈ 2,0 s** — três ordens de grandeza abaixo dos tiers que motivaram o
   enquadramento (`e2e` 240 s, `vitest` 151 s, `db:test` 33 s).

4. **Precondições verificadas por leitura do código, não por suposição:** ambas importam **apenas**
   `node:fs`, `node:path` e `node:url`. Nenhuma toca rede, banco, credencial ou a plataforma. Prova
   independente de que não precisam de dependências instaladas: a light pipeline as executa **sem
   `npm ci`** (a única que o faz). O match de `".neon"` em `m02-secrets-audit.ts` é uma **lista de
   exclusão de diretório**, não acesso.
5. **Assimetria de testabilidade (medida):** `m02:secrets-audit` **exporta `auditSecrets`** para
   consumo direto por teste com raiz sintética (`scripts/m02-secrets-audit.ts:199`), enquanto
   `m02:boundaries` **não aceita argumento algum** — a raiz do repositório e
   `docs/specs/M-02/matrix.yaml` são caminhos fixos (`scripts/m02-boundaries.ts:55-56`). Isso determina
   como cada caso negativo pode ser construído (§6).
6. **Classe de falha já registrada quatro vezes neste repositório:** guarda declarada contrato que não
   roda em gate nenhum. O `AGENTS.md` a nomeia: _"Declarar contrato e não executá-lo é a lacuna, não a
   guarda."_

## 2. Decisão proposta

**Encadear as duas guardas no `npm run check`** e, por consequência, adicioná-las também aos passos
diretos do `verify` do `ui-stack` — porque a cadeia `check` e a lista de passos do YAML são **listas
separadas** (a heavy roda 12 dos 14 scripts da cadeia como passos diretos, não a cadeia inteira).

Ordem proposta dentro da cadeia: imediatamente **após** os quatro guards existentes e **antes** de
`format:check`, mantendo o agrupamento de guardas baratas no início do pipeline.

Nada é removido, nada é afrouxado: a mudança é **puramente aditiva** e o custo é ≈ 2,0 s.

## 3. Contrato (o que a implementação tem de satisfazer)

- **Fail-closed.** Violação ⇒ exit ≠ 0. Precondição indisponível (matriz ilegível, git ausente) ⇒ exit
  ≠ 0 com mensagem de **precondição** — nunca sucesso silencioso.
- **Nenhum `|| true`** e nenhum erro de comando interpretado como ausência de violação.
- **Saída legível:** arquivo/regra violada + motivo + sugestão de correção.
- **Idempotente:** rodar duas vezes seguidas produz o mesmo veredicto.
- **Compatível com a evidência local:** `docs/evidence/local-ci/**`, `_archive/`, bundles e patches
  **não** podem gerar falso positivo. Medido hoje: ambas passam com toda essa árvore presente.
- **Compatível com `metadata-only`:** a política de evidência do ciclo `SDD-20260923` não pode quebrar
  nenhuma das duas.
- **Casos negativos obrigatórios:** um por guarda, executável e versionado.
- **Custo medido e declarado** por guarda e por pipeline.

## 4. Alternativas

| #   | Alternativa                                                          | Veredito                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Encadear **só no `local-ci`**                                        | **Rejeitada.** O `local-ci` é substituto **temporário** enquanto a cota bloqueia; amarrar o fechamento de DBT-19 a ele deixaria a lacuna de volta no primeiro push pós-desbloqueio. Não fecha DBT-19.            |
| A2  | Encadear no **`npm run check`** (+ passos diretos do heavy)          | **Proposta.** Fecha a lacuna nos **dois** pipelines, custa ≈2,0 s, não depende de rede/DB/plataforma e é o que o `AGENTS.md` já descreve como contrato.                                                          |
| A3  | Encadear **só na light**                                             | **Rejeitada.** A light só dispara quando **todos** os arquivos alterados estão sob `docs/evidence/**`; um push de código não a dispara — é exatamente o buraco do fato 2.                                        |
| A4  | Encadear **só no heavy**                                             | **Rejeitada como solução única.** Deixaria a cadeia `check` (o gate local declarado, `Definition of Done` do repo) sem os dois guards, e a divergência entre cadeia e YAML é a classe de defeito que gerou o N7. |
| A5  | Manter como dívida                                                   | **Rejeitada.** É a opção que o próprio registry recusa: a condição de fechamento já está escrita e é satisfazível.                                                                                               |
| A6  | Adicionar `--root`/`--fixture` a `m02:boundaries` para testabilidade | **Adiada, não descartada.** Melhoraria o caso negativo (fixture em vez de mutação+restauração), mas é mudança de código do guard e amplia o escopo desta proposta. Registrada como follow-up.                    |

## 5. Consequências

- **Runtime local:** `npm run check` fica ≈2,0 s mais lento. Aceitável e declarado.
- **CI remoto futuro:** o `verify` ganha dois passos; o custo é ≈2,0 s sobre ≈9,7 min (≈0,3%). Não
  reabre a discussão de cota que motivou o tiering.
- **Desenvolvedores:** uma violação de boundary ou um segredo passa a reprovar **localmente**, antes do
  push — que é o ponto.
- **Evidência:** o `local-ci` já executa as duas como etapas nomeadas; a mudança as torna **também**
  membros da cadeia, e a asserção de cobertura (`checked === discovered`) continua válida por identidade.
- **Risco de falso positivo:** **medido como baixo** — ambas passam na árvore atual com a evidência local
  presente. O risco residual é a árvore de evidência crescer e cair numa varredura; `m02:secrets-audit`
  **já exclui** `docs/evidence/**` por construção.
- **Registro da dívida:** fechar DBT-19 exige escrita no `DEBTS.md`, cujo escritor é o **MAESTRO** —
  portanto o fechamento é **ato humano**, mesmo depois da implementação.

## 6. Testes (contrato de prova)

| #   | Teste                                      | Como                                                                                                                    | Esperado                                                                         |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| T1  | **Closure test** (exigido pelo registry)   | teste executável que roda as duas guardas na árvore real                                                                | exit 0                                                                           |
| T2  | **Caso negativo de boundary**              | mutar `docs/specs/M-02/matrix.yaml` acrescentando um `databasePaths` não-allowlisted → rodar → **restaurar por sha256** | exit 1 nomeando `bff -> path`                                                    |
| T3  | **Caso negativo de segredo**               | chamar `auditSecrets` com raiz sintética contendo segredo falso **claramente não-real**                                 | `failures.length > 0`                                                            |
| T4  | **Precondição**                            | matriz ilegível/ausente (fixture)                                                                                       | exit ≠ 0 **de precondição**, nunca sucesso                                       |
| T5  | **Sem falso positivo com evidência local** | rodar com `docs/evidence/local-ci/**` e `_archive/` presentes                                                           | exit 0                                                                           |
| T6  | **Custo**                                  | 3 execuções de cada, cronometradas                                                                                      | ≤ 3 s cada (medido: 0,213 s e 1,803 s)                                           |
| T7  | **Asserção da tabela do `AGENTS.md`**      | teste que compara a tabela com os YAMLs e a cadeia `check`, **por identidade** de passo                                 | falha quando um passo é removido do YAML (controle negativo da própria asserção) |

T2 usa o padrão que este repositório já adota para RED de guarda: **mutação restaurada por sha256**
(`captures/mutacao-*.sh.txt` nos selos do WP-R6/WP-R7). T3 é mais limpo porque a guarda **já exporta**
a função auditável — nenhuma mutação do repositório é necessária.

## 7. Rollback

`git revert` do commit de implementação. Como a mudança é aditiva e não altera o comportamento de
nenhum guard, o revert restaura exatamente o estado atual. Este ADR permanece no repositório como
`REJEITADA`/`SUPERADA` se o revert for a decisão, e o registro vai para o journal.

## 8. Aprovação

**Requer aprovação humana/contratual explícita antes de alterar gates.** Enquanto ela não existir, este
ADR fica em **PROPOSTA** e a implementação **não** é iniciada — nem `package.json`, nem `npm run check`,
nem workflows, nem `local-ci.sh` em ponto que mude veredicto, nem `DEBTS.md`.

## 9. Errata (2026-09-23, durante a implementação aprovada)

O contrato foi **aprovado** (`APPROVE_ADR_030=yes`) com a condição _"nenhuma guard pode ser adicionada
sem prova de que sabe reprovar"_. Executados os casos negativos (T1–T5), a prova **reprovou para
`m02:secrets-audit`** e o encadeamento **não** foi feito. Duas correções ao corpo acima:

1. **§1.5 (assimetria de testabilidade) — superada, para melhor.** O plano previa mutar
   `docs/specs/M-02/matrix.yaml` e restaurar por sha256 (RISK-02). Como o guard lê **apenas** a matriz e
   usa `existsSync` nos caminhos de catálogo (sem `readdir`), o caso negativo roda sobre uma **cópia** em
   `mkdtemp` com placeholders de catálogo: **o repositório real nunca é mutado** e RISK-02 deixa de
   existir. Evidência: `docs/sdd/SDD-20260923-boundary-guard-dbt19/07-evidence.md`.
2. **§2 (decisão) — bloqueada por um fato novo e medido.** `m02:secrets-audit` **detecta** literais de
   segredo (`possible_secret_literals`, três padrões) mas **não reprova por eles**: o bloco `main` decide
   o exit code apenas por cobertura (`coverage.failures.length ? 2 : 0`). Medido: com um `ghp_…` falso no
   fixture, o CLI sai **0**. Logo o contrato real da guarda é **mapa de consumidores com cobertura
   fail-closed** — não um gate de segredo. Encadeá-la como está produziria **cobertura de segredo apenas
   aparente**, exatamente a classe de defeito que DBT-19 denuncia.

**Consequência:** a decisão A2 fica **pendente de uma escolha humana** entre (a) corrigir o exit code da
guarda para considerar `possible_secret_literals` — o que **altera a semântica** de uma guarda
compartilhada e por isso está **fora** do não-objetivo declarado em §4 —, (b) encadear apenas
`m02:boundaries` (falsificável, provado) e reescopar a metade de segredos de DBT-19, ou (c) manter ambas
fora do gate e declarar a limitação. **Nada foi implementado em nenhum dos casos.**

## 10. Errata de estado — `DBT-19` **não** está fechada (2026-09-24)

Esta errata corrige um **overclaim meu**, apontado por auditoria independente (agente de observabilidade
de contrato de gate) e verificado ponto a ponto.

### 10.1 O que eu afirmei

`AGENTS.md` passou a dizer **três vezes** "DBT-19 **fechado** em 2026-09-23", e o journal (`L166`) e o
ledger declararam "DBT-19 **tecnicamente fechada**".

### 10.2 O que é verdade

| Fato                                                                                            | Estado                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| As duas guardas estão no encadeamento do `check` (16 membros) e como passos diretos do `verify` | **VERDADE** (commit `c7e6a55`)                                       |
| Existe caso negativo que as falsifica (`src/test/m02-boundary-gate.test.ts`, 6 casos)           | **VERDADE**                                                          |
| A tabela de cobertura do `AGENTS.md` **corresponde** aos YAMLs                                  | **VERDADE** — conferido à mão                                        |
| A tabela corresponde **por asserção de teste** (exigência literal do registry)                  | **FALSO**                                                            |
| `DBT-19` está fechada no registry                                                               | **FALSO** — `DEBTS.md` diz `ABERTA`, e o fechamento é ato do MAESTRO |

### 10.3 Por que a asserção não existe

`src/test/m02-ci-coverage.test.ts` lê **apenas** os dois YAMLs (`heavyReal`, `lightReal`) — **não lê
`AGENTS.md` nem `package.json`**. E **nenhum teste pinna a cadeia `check`**: um `grep` de
`scripts.check`/`m02:lockfile-guard` em `src/test/*.ts` retorna **zero ocorrências**, de modo que um
gate pode ser **removido** dos 16 membros com **todos os gates verdes**. Essa é a mesma classe de
defeito que `DBT-19` denuncia — declarar cobertura que nenhuma asserção sustenta.

### 10.4 O que fica devido

1. **Asserção que faça a tabela do `AGENTS.md` bater com os YAMLs por teste** (hoje só conferida à mão).
2. **Pin da cadeia `check`** — para que remover um gate reprove.
3. **Fechamento de `DBT-19` pelo MAESTRO**, com a condição de closure cumprida nas **duas** metades.

Os itens 1 e 2 são **código/teste** e foram explicitamente **deferidos** para um ciclo de código por
decisão humana de 2026-09-24. Este ADR **não** os implementa.
