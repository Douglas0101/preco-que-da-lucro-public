# 06 — Rastreabilidade · SDD-20260923-local-ci-hardening

## Requisito → caso negativo → implementação → evidência

| REQ                                                        | Caso negativo                                                                                       | Implementação                                                                 | Evidência                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **REQ-01** ruído do scan reduzido sem perder detecção      | N1–N4 (detecção), N5–N7 (escopo), **N8** (padrão duro na mesma linha)                               | `scripts/local-ci-secret-allowlist.json` + `scripts/local-ci-secret-scan.mjs` | `07-evidence.md` AC-01/AC-02; `total=14 permitidos=12 autodeclarados=2 hits=0` |
| **REQ-02** allowlist mínima, declarada, escopada           | **N10** (campos obrigatórios, escopo não-global, nenhum padrão real)                                | 5 entradas, todas usadas; 2 podadas                                           | `03-design.md` §2                                                              |
| **REQ-03** allowlist ilegível nunca vira "nada encontrado" | **N9** (campo ausente ⇒ exit 2)                                                                     | `fail()` no módulo + `precondition` no pipeline                               | `07-evidence.md` AC-03                                                         |
| **REQ-04** autodeclaração não é ponto cego                 | **N11** (padrão duro no arquivo de allowlist continua hit), **N12** (não é hit pelo próprio padrão) | `SELF_DECLARATION_PATHS` avaliado **depois** de `HARD_PATTERNS`               | `03-design.md` §3                                                              |
| **REQ-05** manifesto declara fotografia temporal           | —                                                                                                   | `measuredAt`, `countsAreSnapshotAt`                                           | `07-evidence.md` AC-04                                                         |
| **REQ-06** contagens reproduzíveis                         | —                                                                                                   | cross-check `linhas == filesGitTrackable − 1`                                 | AC-05 (`92 = 93 − 1`)                                                          |
| **REQ-07** `manifest.sha256` no selo                       | —                                                                                                   | conjunto estabilizado antes da medição; ordem em `finalize`                   | AC-06 (`grep -c` = 1)                                                          |
| **REQ-08** selagem recusa árvore suja                      | —                                                                                                   | precondição exit 2                                                            | AC-07 (medido 3×)                                                              |
| **REQ-09** escape testado e registrado                     | —                                                                                                   | `tree-state.txt` → manifesto + pendência nominal                              | AC-08                                                                          |
| **REQ-10** nenhum gate/contrato alterado                   | —                                                                                                   | nenhum arquivo de gate tocado                                                 | AC-09/AC-10 (`git diff` por commit)                                            |
| **REQ-11** detector que não detecta não passa              | —                                                                                                   | teste de vivacidade (5 probes)                                                | `03-design.md` §4                                                              |

## `checked === discovered`

- **Casos negativos declarados no despacho:** N1–N7 (7).
- **Casos implementados:** **N1–N12 (12)** — os 7 exigidos + 5 derivados de riscos identificados no
  desenho (N8 fail-open por linha mista; N9 precondição; N10 minimalidade; N11 autodeclaração não é
  ponto cego; N12 autodeclaração não é hit).
- **`checked === discovered`:** ✅ — nenhum caso exigido ficou de fora, e todo caso implementado tem
  risco correspondente em `05-risk.md`.
- **Descoberta vazia reprova:** o arquivo de teste falha se o módulo não existir (executa o processo
  real; não há cópia da lógica no teste).

## Superfície de gate — verificação por asserção, não por prosa

| Arquivo de gate                      | Tocado neste ciclo? | Como foi verificado                             |
| ------------------------------------ | ------------------- | ----------------------------------------------- |
| `package.json` (cadeia `check`)      | **não**             | `git show --name-only` por commit do Item 5 → 0 |
| `.github/workflows/ui-stack.yml`     | **não**             | idem                                            |
| `.github/workflows/ci-light.yml`     | **não**             | idem                                            |
| `AGENTS.md`                          | **não**             | idem                                            |
| `package-lock.json`                  | **não**             | idem                                            |
| `docs/evidence/agent-state/DEBTS.md` | **não**             | idem (escritor é o MAESTRO)                     |
| `docs/evidence/agent-state/QUEUE.md` | **não**             | idem                                            |

O único commit do range `origin/develop..HEAD` que toca `package.json` é `c7e6a55`, do ciclo anterior
(DBT-19, aprovado) — declarado para que a diferença de escopo não seja lida como contradição.

## Critérios de aceite

Rastreabilidade completa em `02-acceptance.md`: **14/14** com medição nomeada, e o estado final em
`07-evidence.md`.
