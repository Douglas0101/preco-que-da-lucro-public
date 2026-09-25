# Runbook — migração Supabase → Neon

## Pré-condições

- Neon develop provisionado; nunca começar em produção.
- `DATABASE_ADMIN_URL` direct e `DATABASE_URL` pooled segregadas.
- conexão Supabase direta somente leitura com acesso a `auth` e `public`.
- backup/snapshot confirmado; aplicação ainda no runtime legado.
- secrets fora do repositório.

## Gate manual `Neon readiness`

O workflow de PR `Neon preview database` é opcional. Quando as credenciais não
estão configuradas, ele termina como `skipped` e registra explicitamente que
isso não comprova branch, migration, reconciliação, backup/restore ou cutover.
Esse estado nunca deve ser promovido a `passed`.

Para a evidência operacional, configure no GitHub o environment protegido
`neon-readiness` com reviewers obrigatórios e sem secrets de produção. O
workflow manual exige:

- secret `NEON_API_KEY`;
- variable `NEON_PROJECT_ID`.

O secret `SUPABASE_MIGRATION_DATABASE_URL` (somente leitura, com acesso a
`auth` e `public`) é **opcional**: o projeto nunca rodou oficialmente no
Supabase, portanto o caminho padrão é o provisionamento limpo. Sem esse
secret, o gate valida migrations do zero e sobre schema existente,
privilégios/RLS, ownership e drift, e registra no resumo que a reconciliação
de legado foi pulada; com ele, a reconciliação executa normalmente.

`NEON_PARENT_BRANCH` (default `develop`), `NEON_DATABASE` (default `neondb`) e
`NEON_ADMIN_ROLE` (default `neondb_owner`) são variables opcionais. O workflow
cria uma branch descartável filha de `develop`, valida as URLs direct/pooled,
executa migrations do zero e sobre schema existente, testa privilégios/RLS,
confirma ausência de ownership do `app_runtime`, verifica drift e, quando há
fonte legada configurada, executa a reconciliação. A branch é removida em
`always()`.

Execute-o em **Actions → Neon readiness → Run workflow**, mantendo
`migration_mode=dry-run` na primeira execução. `apply` só pode ser usado na
branch descartável, exige `confirm_apply=true`, permanece com
`MIGRATION_ALLOW_UPSERT=false` e não é autorização de cutover.

O contrato de ambiente permanece sem renomear variáveis:

| Variável                          | Uso                      | Regra                                                              |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `DATABASE_URL`                    | runtime pooled           | recebido da URL pooled da branch de teste                          |
| `DATABASE_ADMIN_URL`              | migrations/admin direct  | recebido da URL direct da branch de teste                          |
| `SUPABASE_MIGRATION_DATABASE_URL` | origem legada (opcional) | read-only; nunca entra no runtime; ausente = provisionamento limpo |
| `MIGRATION_APPLY`                 | importação               | `false` no dry run; `true` somente com confirmação explícita       |
| `MIGRATION_ALLOW_UPSERT`          | destino não vazio        | sempre `false` no workflow protegido                               |
| `MIGRATION_REPORT_PATH`           | relatório                | arquivo privado em artifact com retenção curta                     |

O job falha antes de provisionar a branch quando qualquer credencial
obrigatória está ausente. O relatório só é aceito com
`sourceMode=read-only-repeatable-read`, `different=0`,
`sessionsImported=0` e zero órfãos. O artifact e o resumo do job registram a
fronteira: esse gate é uma prova de readiness em branch descartável, não uma
prova de troca de secrets, produção, OAuth, Resend ou cutover real.

## Dry run develop

```bash
npm run db:migrate
MIGRATION_APPLY=false npm run migration:legacy-to-neon
npm run db:test
npm run check
```

O dry run importa e reconcilia dentro da mesma transação e depois executa rollback. Salve o relatório com `MIGRATION_REPORT_PATH` em uma área segura. Nunca publique o arquivo se contiver exceções operacionais sensíveis.

Repita com `MIGRATION_APPLY=true` somente em uma branch Neon descartável ou no Neon develop aprovado. Se o destino já contém um dry run deliberado, a repetição exige `MIGRATION_ALLOW_UPSERT=true` e revisão prévia.

## Cutover de produção

> Operação no dia do desbloqueio: seguir `a4-a5-cutover.md` (sequência A4 + A5 0h/24h/72h + rollback) com pré-requisito `hpanel-homologacao.md` 11/11 PASS. Abaixo, a referência de dados (válida nos dois ramos G1; G1(a) dispensa freeze/delta).

1. Ativar manutenção/read-only no runtime Supabase.
2. Confirmar que não existem escritas em andamento.
3. Criar snapshot/PITR do Neon e registrar horário.
4. Executar migrations.
5. Fazer export final e import com `MIGRATION_APPLY=true`.
6. Exigir relatório com `different: 0`, `sessionsImported: 0` e ausência de órfãos.
7. Trocar secrets para pooled/direct, Better Auth, Google e Resend.
8. Executar `/api/health/live`, `/api/health/ready`, login, CRUD tenant-scoped, chat e smoke financeiro ainda sem liberar escrita pública.
9. Liberar escrita no Neon e monitorar autenticação, erros por código, latência DB/IA e cálculos inválidos/incompletos.

## Vigilância pós-deploy (A5) e KPIs B3

> Adendos de 2026-09-05 (auditoria de substrato,
> `docs/evidence/substrato-2026-09-05/report.md`). O deploy A4 metade 2 ainda não
> ocorreu; esta seção define as checagens antes do primeiro tráfego real.

### Checagens 0h (registro imediato pós-smoke)

- `deployed_at` e `smoke_passed_at` registrados no ledger (UTC).
- `npm run smoke:substrate` verde contra o Neon de produção (read-only):
  major 17, journal/hashes reconciliados, `app_runtime` sem superuser/BYPASSRLS,
  RLS ativa nas tabelas de tenant, `issuer IS NULL` = 0.
- `GET /api/health/live` e `/api/health/ready` → 200 via URL pública.
- Login com conta controlada pelo operador; senha errada rejeitada;
  logout/relogin; acesso sem sessão bloqueado.
- Versão better-auth atendendo tráfego confirmada (1.7.x exige issuer preenchido).

### Checagens 24h

- Zero spike de 401 pós-deploy; contagens de `rate_limits`/429 sem anomalia.
- Contas novas: issuers esperados; nenhuma linha com issuer nulo.
- Erros por código, latência DB (`app.context_tx`, métricas `app.*`) sem
  regressão versus o smoke.
- Sem incidente P0/P1 no ledger.

### Checagens 72h

- Mesmos indicadores de 24h, janela completa.
- Reconciliação contábil leve (contagens por tabela sem divergência inexplicada).
- Decisão documentada: manter Neon como destino único; origem Supabase
  permanece congelada (retenção ADR-021 §9).

### Critérios de abort

Qualquer um dos itens aborta a janela A5 e dispara rollback pelo runbook:

- erro financeiro crítico ou cross-tenant observado em produção;
- `ready` 5xx sustentado (> 15 min) com banco acessível;
- spike de 401 pós-deploy indicando sessão/issuer quebrados;
- divergência de contagem inexplicada em tabela financeira;
- falha no `smoke:substrate` em qualquer reexecução da janela.

### KPIs B3 — baseline

Não existe baseline do Supabase: a origem nunca serviu tráfego oficial e não há
janela de medição pré-cutover. Por spec (M02-D-008), o baseline é
**não mensurável (amostra zero)** — nenhuma taxa zero é inventada. B3 compara a
janela pós-deploy contra os limites do Plano Mestre §46 e o error budget §30,
com ambiente, versão, amostra e cobertura temporal identificados (§6 do relatório
`checagens-pos-publicacao-2026-09-05`).

## Rollback

- Antes de escrita no Neon: restaurar os secrets/runtime Supabase e retirar manutenção.
- Depois de escrita no Neon: manter manutenção e restaurar snapshot/PITR do Neon. Não copiar as novas escritas de volta ao Supabase.
- Não reativar dual-write.

## Retenção da origem

Congele o Supabase por 14 dias. A exclusão ou desativação não faz parte deste runbook e só pode ocorrer após aprovação explícita do proprietário.
