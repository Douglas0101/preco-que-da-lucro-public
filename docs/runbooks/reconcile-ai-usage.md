# Runbook — reconciliação de uso de IA sem medição

## Por que isto existe

Quando o gateway não informa o consumo de uma chamada, `settle` grava
`ai_usage.outcome = 'usage_unknown'`, deixa `real_tokens` **nulo** e **retém** a
reserva em `ai_daily_budgets.tokens_reserved` (`src/lib/ai/budget-ledger.server.ts`).
Reter erra para o lado seguro — liberar afirmaria consumo zero, que foi exatamente
o que escondeu uso do teto diário antes do `INV-006`.

O efeito colateral é que a reserva fica retida para sempre: o varredor de reservas
(`sweepOrphans`) só alcança `status = 'reserved'`, e um evento liquidado está em
`status = 'settled'`. Os dois predicados são disjuntos, então nada revisitava o
evento — e o teto diário do tenant encolhia sem consumo real.

A reconciliação fecha essa lacuna. Ela **não** mede o consumo: o gateway é
OpenAI-compatível em `/v1/chat/completions`, sem retrieval por id, e `ai_usage`
não guarda payload — re-consultar o uso é estruturalmente impossível. O que ela
faz é tornar o estado **persistido e auditável**.

## Job periódico

```
npm run db:reconcile-ai-usage -- --all-tenants
```

O que ele faz, por tenant: seleciona `status = 'settled'` + `outcome = 'usage_unknown'`
com `settled_at` mais antigo que o corte, e marca cada linha como
`outcome = 'reconciliation_failed'` — compare-and-set por `usage_id`, então replay
é no-op. `status` continua `settled`, `real_tokens` continua nulo e
**`tokens_reserved` não é tocado**.

Flags:

| flag               | efeito                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `--all-tenants`    | enumera tenants com membro owner/admin (lê só `tenant_memberships`) |
| `--tenant <uuid>`  | restringe a um tenant (repetível)                                   |
| `--min-age-ms <n>` | corte de idade desde `settled_at` (padrão: 6 h)                     |
| `--batch-size <n>` | teto por execução (padrão: 100, máximo: 1000; `0` é recusado)       |
| `--dry-run`        | mostra o que seria marcado, sem escrever                            |

Linha de cron (horária, minuto deslocado para não competir com outros jobs):

```cron
17 * * * * cd /srv/preco-que-d && DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" npm run db:reconcile-ai-usage -- --all-tenants >> /var/log/reconcile-ai-usage.log 2>&1
```

`DATABASE_ADMIN_URL` vem do cofre de ambiente do host — **nunca** de um arquivo
versionado. O script recusa qualquer URL que não seja loopback antes de abrir
conexão, então ele não roda contra produção nem por acidente de configuração.

**Exit code:** `0` quando o job roda — inclusive quando marca eventos, porque
marcar é o desfecho correto deste caminho, não uma falha. `1` é reservado para
erro real (banco inacessível, argumento inválido).

**Quem alarma — e a pegadinha:** o alarme que **existe hoje** é o evento
estruturado `ai.reconciliation_failed` (`logJson`, nível `warn`), uma linha por
evento tratado, que cai no log do cron.

As métricas `app.ai.reconciliation_total`, `app.ai.reconciliation_failed` e
`app.ai.reconciliation_oldest_age_ms` estão declaradas e o job chama
`startTelemetry()`/`flushTelemetry()` (o flush é obrigatório porque o exportador
periódico padrão de 15 s nunca dispara em um processo que termina em segundos).
**Mas elas não saem do processo — nem com o endpoint OTLP configurado.**

O motivo é medido, não suposto: o `meter` e os instrumentos de
`applicationMetrics` são criados no **import** de
`src/instrumentation/telemetry.ts`, quando a API ainda devolve os singletons
noop (`NOOP_METER` compartilhado, `add()` vazio, `addCallback()` que não registra
nada). Registrar o `MeterProvider` depois, dentro de `startTelemetry()`, **não
re-vincula instrumento já criado** — `@opentelemetry/api` não tem proxy de
métrica (o único proxy da API é o de trace). Com instrumentos noop o
`PeriodicExportingMetricReader` nem chega a invocar o exporter.

O defeito é pré-existente e **repo-wide**: atinge os 102 usos de
`applicationMetrics` em `src/` e `scripts/`, não só este job. Está registrado
como `F-otel-provider-order` (WP próprio, exige ADR).

> Consequência prática: **não** monte alerta sobre `app.ai.reconciliation_*`
> enquanto o D7 não for corrigido. Um alarme sobre métrica que nunca é exportada
> não dispara — exatamente o tipo de controle fantasma que este trilho existe
> para eliminar. Alerte pelo log:
> `grep -c 'ai.reconciliation_failed' /var/log/reconcile-ai-usage.log`.

Linha de cron (a variável OTLP é inócua para ESTE job enquanto o D7 existir;
mantenha-a apenas se o host já exporta telemetria por outros processos):

```cron
17 * * * * cd /srv/preco-que-d && DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" npm run db:reconcile-ai-usage -- --all-tenants >> /var/log/reconcile-ai-usage.log 2>&1
```

## Decisão humana — devolver a reserva

O job **não** devolve orçamento. Devolver é uma decisão explícita, porque o
consumo continua desconhecido e o número devolvido nunca foi medido.

```bash
# 1. ver o que está pendente (não escreve nada)
npm run db:reconcile-ai-usage -- --tenant <uuid> --dry-run

# 2. revisar os eventos marcados (a liberação só aceita outcome = reconciliation_failed)
#    os usage_id aparecem na saída do job acima

# 3. dry-run da liberação: mostra o que seria devolvido
npm run db:release-unknown-reservations -- --tenant <uuid> --usage-id <uuid>

# 4. aplicar (devolve tokens_reserved; real_tokens continua NULL)
npm run db:release-unknown-reservations -- --tenant <uuid> --usage-id <uuid> --confirm
```

Cada liberação emite o evento estruturado `ai.reservation_released` com
`tenantId`, `usageId`, `budget` (tokens devolvidos) e `actor` (quem autorizou).
Repetir o comando é seguro: o compare-and-set não encontra mais o evento e
responde "não aplicou", sem devolver o valor duas vezes.

## Verificação

```bash
# nenhum evento deveria ficar sem tratamento além do corte configurado
psql "$DATABASE_ADMIN_URL" -c "
  select tenant_id, count(*), min(settled_at) as mais_antigo
  from ai_usage
  where status = 'settled' and outcome = 'usage_unknown'
    and settled_at < now() - interval '6 hours'
  group by tenant_id"
```

Linhas aqui são reserva retida aguardando decisão. Zero linhas é o estado
esperado depois de uma passada do job.

## Rollback

Não há migration e não há schema novo: `outcome` é `text` sem CHECK, e o job só
muda um rótulo. Reverter o código (`git revert` do commit do WP) e remover a linha
de cron basta. As linhas já marcadas `reconciliation_failed` permanecem
verdadeiras — o uso **foi** desconhecido, então reverter o código não as torna
falsas.

## Proibições

- Não inventar um número para "fechar" o evento: `real_tokens` nulo é o registro
  honesto de que não houve medição.
- Não converter desconhecido em zero em nenhum contador.
- Não liberar em massa: cada devolução é revisada e auditada.
- Não rodar contra produção: os guards recusam host não-loopback.
