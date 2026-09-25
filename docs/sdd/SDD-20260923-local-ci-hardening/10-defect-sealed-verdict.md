# 10 — Defeito declarado: veredicto contradito no selo da rodada `1b54a89c`

> **Este documento existe para que o defeito fique registrado em vez de apagado.** A rodada
> `docs/evidence/local-ci/1b54a89c3fe9d4489828bafdbe98eee30e28f2b8/` **não** é citável como evidência de
> veredicto. Nada dentro dela foi reescrito.

## 1. O que está errado

| Fonte                                      | Valor                                    |
| ------------------------------------------ | ---------------------------------------- |
| `result.txt` (selado)                      | `failure`                                |
| `manifest.json.result`                     | **`success`** — falso                    |
| `REPORT.md`                                | afirma `success`                         |
| `pendencies`                               | `[]` — o rebaixamento não registrou nada |
| **Selo versionável**, hash de `result.txt` | `81b2bd4e…` = hash de `success\n`        |
| Conteúdo real de `result.txt`              | `ec7f201f…` = hash de `failure\n`        |
| `sha256sum -c` no selo versionável         | **FALHA** (`result.txt: FALHOU`)         |
| **Selo integral** (`1b54a89c….sha256`)     | `ec7f201f…` — **correto**                |

**Os dois selos da mesma rodada discordam sobre o veredicto**, e o versionável não verifica.

## 2. Causa raiz (estava viva no código até 2026-09-24)

Em `finalize`, a ordem era: `generate_git_checksum` → `verify_git_checksum` (que **falhava**) →
rebaixamento reescrevia `result.txt=failure` → só então `seal_evidence`. Quando o cross-check de
contagens disparava, `manifest.json`, `manifest.sha256`, `REPORT.md` e o **selo versionável** já estavam
gravados com `success` e **nada os regenerava**.

Ou seja: a correção do L1 (ciclo anterior) fechou a **causa** da divergência de contagem, mas não a
**consequência** de uma verificação que falha depois da geração.

## 3. Correção aplicada (2026-09-24)

1. **O cross-check de contagens passou a rodar ANTES da geração dos artefatos** (dentro de
   `close_evidence_policy`, comparando com `evidence-counts.json`). Decidir o veredicto antes de gerar é
   o que impede a contradição — o caminho comum agora rebaixa e **depois** gera coerente.
2. **Rede de segurança (pass 4):** se `verify_git_checksum` ainda reprovar após a geração, o `finalize`
   **regenera** manifesto, `manifest.sha256`, REPORT e selo com o veredicto final; se ainda assim
   reprovar, grava **pendência nominal** `evidence-contradiction`.
3. **Invariante final:** `result.txt` e `manifest.result` têm de ser o **mesmo**. Divergência ⇒ pendência
   nominal + veredicto `failure` + regeneração.

## 4. Controle negativo da correção

O bloco da invariante foi **extraído do script real** (não copiado à mão — o padrão de
`src/test/m02-ci-tiers.test.ts`) e exercitado contra três fixtures:

| Caso  | Entrada                                                                    | Esperado    | Medido                                     |
| ----- | -------------------------------------------------------------------------- | ----------- | ------------------------------------------ |
| 1     | `result.txt=failure`, `manifest=failure`                                   | não dispara | **não disparou** ✅                        |
| **2** | `result.txt=failure`, `manifest=success` ← **o cenário real desta rodada** | **dispara** | **disparou** `[evidence-contradiction]` ✅ |
| 3     | `result.txt=success`, `manifest=success`                                   | não dispara | **não disparou** ✅                        |

O caso 2 é o controle **positivo** do defeito: ele reproduz exatamente o estado de `1b54a89c` e prova
que o instrumento agora **recusa** terminá-lo em silêncio.

## 5. Por que a rodada **não** foi regenerada

Regenerar `manifest.json`/`REPORT.md`/selos de `1b54a89c` apagaria o **registro de que o defeito
existiu** — e o valor de auditoria de um selo defeituoso preservado é maior do que o de um selo
retroativamente corrigido. A decisão foi humana, em 2026-09-24: **corrigir o instrumento e declarar a
rodada histórica**, não reescrever evidência selada.

**Consequência aceita:** `1b54a89c` permanece com o selo versionável inválido. Quem o encontrar deve ler
este documento antes de tratá-lo como falha de integridade do repositório: é o registro de um defeito
**corrigido**, preservado de propósito.

## 6. Alcance

Medido em 8 rodadas: `1b54a89c` é a **única** com contradição entre `result.txt` e `manifest.result`. As
demais são consistentes e seus selos versionáveis conferem (0 falhas).
`3b88391d` foi inicialmente apontada por auditoria como contradição, mas é **aborto de precondição sem
`manifest.json`** (4 arquivos, sem selo) — não é veredicto contradito.
