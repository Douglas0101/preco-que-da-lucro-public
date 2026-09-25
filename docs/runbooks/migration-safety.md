# Runbook — Segurança de migrations (expand/contract)

Política para toda mudança de schema em `drizzle/`. O vocabulário vive em
`scripts/db/migration-classes.ts` (registry sidecar) e é validado por
`npx tsx scripts/db/check-migration-classes.ts` (§27a): bijeção
`drizzle/meta/_journal.json` ↔ registry ↔ `drizzle/*.sql`, sha256 byte a byte e regras por classe.

Nenhum cabeçalho de classe entra nos `drizzle/*.sql` publicados: o Drizzle calcula sha256 do conteúdo
integral e o banco guarda esse hash em `drizzle.__drizzle_migrations`; um header retroativo quebraria
o replay e o contrato de hash.

## Classes

| Classe             | Definição                                                                    | Obrigação no registry                                     |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `SAFE`             | Aditiva, sem DML e sem lock relevante; aplicável a qualquer momento.         | Nenhuma além de `rationale`/`evidence`/`sha256`.          |
| `ONLINE_WITH_CARE` | Aditiva/DML leve com lock ou risco operacional (janela, role global, scan).  | `onlineCare` com o risco e a janela recomendada.          |
| `DATA_MIGRATION`   | Altera dados existentes (backfill/convert).                                  | `idempotent: true` + `rollback` verificado (checker).     |
| `BREAKING`         | Remove/renomeia coluna, tabela ou constraint consumida por versão publicada. | `contractOf` apontando para a migration expand (checker). |

`appliedOn`: `empty` = aplicada quando o banco ainda não tinha dados de aplicação (as 12 atuais);
`live` = havia dados — o PR precisa do plano de backfill e do caminho de rollback.

**Enforcement:** o checker só bloqueia mecanicamente `DATA_MIGRATION` (regras acima) e `BREAKING`
(`contractOf`). A política de 6 passos abaixo é **exigida apenas para `BREAKING`**;
`SAFE`/`ONLINE_WITH_CARE` são revisão de PR com o `onlineCare` declarado.

## Política expand/contract (6 passos)

Toda mudança incompatível é fatiada em passos independentes e reversíveis; nenhum deploy precisa
derrubar leitura ou escrita.

| #   | Passo                    | Artefato exigido                                                                 | Rollback                                                       |
| --- | ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Expand                   | Migration aditiva (`ADD COLUMN` nullable / `CREATE TABLE`) + entrada no registry | Down da própria migration enquanto nada lê/escreve a novidade. |
| 2   | Escrita dupla por coluna | Código escrevendo a coluna antiga **e** a nova + teste de paridade dos valores   | Revert do deploy (flag); nenhum dado se perde.                 |
| 3   | Backfill com checkpoint  | Passo do runner §28 (keyset, batch, idempotente) + relatório JSON                | `--reset` do checkpoint ou no-op; a coluna antiga não muda.    |
| 4   | Ler nova                 | PR trocando as leituras + evidência de paridade (contagens/consultas)            | Revert do deploy para a leitura antiga.                        |
| 5   | Parar escrita antiga     | PR removendo a escrita antiga + janela sem divergência observada                 | Revert do deploy; a escrita nova permanece.                    |
| 6   | Contract                 | Migration `BREAKING` com `contractOf` + janela + backup verificado               | Restore de snapshot (DROP não é reversível no chain).          |

Passos 1–2 não mudam leitura; 4–5 não mudam schema. O contract é o único passo irreversível e por
isso só roda depois que nenhum consumidor toca a coluna antiga.

### Template copiável

```ts
// scripts/db/migration-classes.ts — nova entrada (sha256 real do arquivo)
{
  tag: "0012_nome_da_migration",
  class: "DATA_MIGRATION",
  rationale: "Backfill bounded e idempotente de X a partir de Y.",
  evidence: ["drizzle/0012_nome_da_migration.sql", "drizzle/rollback/0012_to_0011_down.sql"],
  sha256: "<sha256sum drizzle/0012_nome_da_migration.sql>",
  idempotent: true,
  rollback: "drizzle/rollback/0012_to_0011_down.sql",
  appliedOn: "live",
}
```

```sql
-- Passo 1 (expand): coluna nova nullable, sem default volátil
ALTER TABLE "products" ADD COLUMN "price_source" text;
-- Passo 6 (contract), só após os passos 2–5:
ALTER TABLE "products" DROP COLUMN "legacy_price";
```

Checklist antes do contract: nenhuma query referencia a coluna antiga; contagem de nulls na nova é
zero; backup/snapshot verificado; `contractOf` preenchido; janela de observação combinada.

## Retroativos (as 12 aplicadas)

- `0007` + `0010` — par expand→backfill canônico: coluna `accounts.issuer` nullable (`SAFE`,
  `IF NOT EXISTS`) e backfill bounded/idempotente (`DATA_MIGRATION`). O contract (remover o
  discriminador legado) ainda não aconteceu.
- `0004` — exceção autorizada: expand + backfill na **mesma** migration porque o alvo era banco
  pré-dados. O preflight em `scripts/db/migrate.ts:25-86` reconcilia totais, converte o discriminador
  e aborta fail-loud (`RAISE EXCEPTION 'purchase_price_history contains an orphaned target'`) antes
  do migrator; não vira precedente para banco com tráfego.
- `0008` — expand puro: `DROP NOT NULL` + colunas aditivas + índice único; sem backfill.
- `0011` — fora do eixo: normalização idempotente de RLS, não altera contrato de dados.

As demais (`0000`–`0006`, `0009`) são estruturais/pré-dados e estão em `SAFE`/`ONLINE_WITH_CARE`.

## Dívida rastreada

O primeiro `BREAKING` real — remover `purchase_price_history.subject_id` depois que nenhum leitor o
usa — segue os 6 passos acima e abre item no ledger; até lá a coluna legada permanece no lugar.
`0010` fica como está (bounded e idempotente); não há downgrade automático pós-tráfego — o caminho é
restore de snapshot.

## Operação

```bash
npx tsx scripts/db/check-migration-classes.ts          # gate: exit 1 em divergência
npx tsx scripts/db/check-migration-classes.ts --write  # regenera a evidência datada
sha256sum drizzle/0012_nome_da_migration.sql           # hash para o registry (byte a byte)
```

Evidência gerada: `docs/evidence/migration-classification-<data>.md`.
