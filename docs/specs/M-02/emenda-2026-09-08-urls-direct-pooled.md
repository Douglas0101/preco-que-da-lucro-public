# Emenda 2026-09-08 - §12.2 URLs direct/pooled e alvo de restore

Status: **APLICÁVEL no working tree; sem commit humano**. Esta emenda é um
addendum ao Plano Mestre, não substitui o texto canônico de §12.2
(`docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md:1050-1066`).

## 1. Mapeamento efetivo

O Plano Mestre usa os nomes ilustrativos `DATABASE_URL_POOLED` e
`DATABASE_URL_DIRECT`. O código e os operadores deste repositório usam o
seguinte contrato fechado:

| Variável                                      | Tipo/escopo             | Uso permitido nesta norma                                                                     | Escrita                                   |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL`                                | pooled                  | runtime web e transações curtas do aplicativo                                                 | nunca em A2                               |
| `DATABASE_ADMIN_URL`                          | direct                  | operador, snapshot e origem read-only de verificações; migration somente na janela sancionada | produção read-only fora do cutover humano |
| `DATABASE_RESTORE_URL`                        | direct                  | alvo efêmero de restore/probe/reparo                                                          | branch `drill-branch` somente             |
| `DATABASE_URL_UNPOOLED`                       | direct legado           | alias de transição, não usar no runtime nem no dia A4                                         | proibida na rodada                        |
| `DATABASE_URL_POOLED` / `DATABASE_URL_DIRECT` | nomes canônicos antigos | documentação do Plano Mestre; não são envs consumidas pelos operadores atuais                 | n/a                                       |
| `SUPABASE_MIGRATION_DATABASE_URL`             | legado D2               | somente V2b após credencial humana read-only                                                  | nunca em A2                               |

## 2. Regras de segurança

- `DATABASE_ADMIN_URL` e `DATABASE_RESTORE_URL` devem usar endpoints direct;
  pooler não serve para restore, grant repair ou seed de branch.
- Origem e alvo devem ter identidades distintas. O alvo não pode ser o
  endpoint de production; `scripts/db/grant-repair.ts` e
  `scripts/rls-probe.mjs` fazem esse hard-deny antes de qualquer conexão.
- `m02:grant-repair` e `m02:rls-probe` exigem hook npm, motivo
  `ALLOW_REMOTE_DB` sem URL e `DATABASE_RESTORE_URL` para qualquer escrita
  remota. O guard não imprime valores de env; os relatórios registram somente
  nomes/identificadores permitidos.
- `DATABASE_URL_UNPOOLED` permanece no conjunto examinado pelo guard para
  detectar hazard, mas não é um caminho alternativo para a regra.

## 3. Estado de fechamento

O documento fecha a ambiguidade documental B2. O split físico do `.env`, a
configuração real de pooled/direct e a assinatura humana continuam pendentes;
portanto o item 8 de §42 não é promovido a PASS. A2 comprovou o reparo do
catálogo em branch, mas falhou no probe RLS e não emitiu PS-S5.
