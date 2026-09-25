# Matriz de Hipóteses do Cutover A4 (Fase 0.2)

Publicada **ANTES** da homologação hPanel e do smoke A4 (princípio "investigar
sem improvisar"). Cada item da homologação e cada passo do smoke executa a
sonda da sua hipótese; resultado ≠ esperado → **FAIL → bundle forense
(`m02:forensic-bundle`; contrato em `docs/forensic-kit.md`) → ABORT**. Achado
fora desta matriz → PARAR e reportar. Todo resultado entra na classificação
SDD: CONFORME / GAP-DOC / VIOLAÇÃO / FALSO-ALARME / DESCONHECIDO.

Precedentes fixos do dia: BLOCKER-EXT-01 desbloqueado; URL preview temporária
(nunca o domínio canônico antes do 11/11); evidência nunca contém valores de
secrets (apenas presença/ausência). Slots de evidência: `docs/evidence/hpanel-homologacao-<AAAA-MM-DD>/`
(numerados 01–11, nomes do runbook `hpanel-homologacao.md`), JSON do
`smoke:substrate`, `docs/evidence/fase0-<data>/` para probes da Fase 0 e
baseline 0h.

## Tabela H-xx

| H    | Hipótese                                                                          | Sonda (comando)                                                                                                                                              | Esperado                                                                                                                                      | Evidência        | Mapeia                  |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------- |
| H-01 | Node no alvo ≥ 24.15 no host                                                      | `node --version && npm --version`                                                                                                                            | v24.15.0+ (teto menor = ABORT geral)                                                                                                          | 01-node          | homologação 1           |
| H-02 | App inicia via start customizado com PORT/NITRO_PORT e HOST/NITRO_HOST            | start `npm run start`; `ps aux \| grep -F '.output/server/index.mjs'`; `env \| grep -E '^(PORT\|NITRO_PORT\|HOST\|NITRO_HOST)=' \| sed 's/=.*/=<presente>/'` | processo do artefato; variáveis presentes; preview roteia                                                                                     | 02/03/04         | homologação 2/3/4       |
| H-03 | Estado persiste entre restarts (volume/env) e processo ressuscita                 | item 5 (3× `curl .../api/health/live` em 15 min) + item 6 (`kill <pid>`; 60 s; `ps`; curl)                                                                   | 3× 200; novo PID; live 200                                                                                                                    | 05/06            | homologação 5/6         |
| H-04 | Proxy sustenta conexões > 60 s                                                    | `time curl -X POST .../api/chat --max-time 120` (item 8)                                                                                                     | sem corte ≤ 60 s                                                                                                                              | 08               | homologação 8; smoke c  |
| H-05 | Egress TLS ao Neon/Resend/gateway IA                                              | 3 sondas HTTPS públicas sem credenciais (item 9)                                                                                                             | 3/3 alcançáveis; Neon bloqueado = ABORT                                                                                                       | 09               | homologação 9           |
| H-06 | Pooler aceita concorrência do runtime; pool coerente com limite do plano          | baseline 0h: stats de pool; k conexões simultâneas `select 1` como `app_runtime` no pooler (k pré-declarado na Fase 0.3)                                     | zero erros de conexão; saturar com tráfego zero = achado → ABORT                                                                              | baseline + fase0 | smoke a/e (transversal) |
| H-07 | RLS NEGA cross-tenant (leitura E escrita) como `app_runtime` em runtime           | `m02:rls-probe` (design abaixo; executa SOMENTE no smoke A4 a)                                                                                               | NEGAÇÃO documentada nos dois eixos                                                                                                            | smoke a          | smoke a; residual §42   |
| H-08 | Tempo até ready após start/restart dentro do aceitável; cold start medido         | item 6 (60 s até live) + boot→ready cronometrado; cold-start Neon medido na Fase 0.3 (branch efêmera)                                                        | live ≤ 60 s pós-kill; valores registrados (alvo fixado em B3)                                                                                 | 06 + baseline    | homologação 6; smoke c  |
| H-09 | Logs sem secrets                                                                  | `grep -Ei 'postgres://\|api[_-]?key\|secret\|password\|token' <trecho> \| wc -l` (item 7); grep equivalente pós-deploy                                       | grep = 0                                                                                                                                      | 07               | homologação 7; smoke d  |
| H-10 | `/api/health/live` e `/ready` 200 sob domínio                                     | `curl -i https://<host>/api/health/{live,ready}` (item 10)                                                                                                   | live 200; ready 200 (503 = app viva + DB indisponível: bloqueia A4)                                                                           | 10               | homologação 10; smoke   |
| H-11 | Secrets por ambiente corretos                                                     | item 11: nomes exigidos presentes; `env \| grep -c DATABASE_ADMIN_URL` no web = `0`                                                                          | `DATABASE_ADMIN_URL`/`SUPABASE_*`/`MIGRATION_*` ausentes do web                                                                               | 11               | homologação 11; smoke d |
| H-12 | Journal igual ao local (`_journal.json`) com hashes idênticos, estável pós-deploy | `npm run smoke:substrate` (`journal-count`, `journal-hashes`)                                                                                                | contagem igual ao local e hashes reconciliados (a contagem não é fixada em doc)                                                               | smoke JSON       | smoke b                 |
| H-13 | Fixture-free intacto (zero `@preco-que-da.test`)                                  | `smoke:substrate` (`production-fixture-free`)                                                                                                                | 26/26 tabelas zero                                                                                                                            | smoke JSON       | smoke b                 |
| H-14 | Env contract do runtime sem ADMIN/legado                                          | item 11 + env diff (só NOMES) pós-deploy via `m02:forensic-bundle`                                                                                           | `DATABASE_URL` (pooled), `DATABASE_DRIVER`, `BETTER_AUTH_*`, `AUTH_TRUSTED_ORIGINS`, `RESEND_*`, `AI_GATEWAY_*` presentes; proibidos ausentes | 11 + bundle      | smoke d/e               |

## Design H-07 — `m02:rls-probe` (sancionado; executa somente no smoke A4 a)

1. Via `DATABASE_ADMIN_URL` (direct): inserir **2 tenants + 2 usuários
   marcadores** com e-mail no domínio-marcador `@preco-que-da.test` — única
   escrita sancionada do dia; IDs e valores fixos, sempre por **parâmetros
   vinculados** (nunca concatenação).
2. Duas conexões `app_runtime` (pooled) com `set_config('app.current_user_id'
/'app.current_tenant_id', ..., true)` por transação: A tenta `SELECT` e
   `INSERT`/`UPDATE` em tabelas tenant de B, e vice-versa.
3. Expectativa: **todas as tentativas negadas** (0 linhas / exceção de policy).
   Registrar cada tentativa (tabela, eixo leitura/escrita, negada, erro).
4. Cleanup sancionado: `npm run db:purge-fixtures` (dry-run default;
   aplicar com a flag explícita) + re-run `smoke:substrate` →
   `production-fixture-free` 26/26 zero.

- Alternativa zero-escrita (se houver veto): probe em branch-cópia Neon a
  partir do snapshot pré-deploy; resultado rotulado "runtime RLS em réplica" —
  não fecha o residual §42 em produção. Decisão pré-declarada antes do dia.
- Qualquer negação ausente = **VIOLAÇÃO crítica** → ABORT + rollback app-level
  (`hostinger-cloud-node.md` §Operação) + bundle forense. `0010_to_0009_down.sql`
  permanece LOCKED (nunca é caminho de rollback do A4).

## DESCONHECIDOS declarados (estado Fase 0)

| Item                                  | Dono           | Plano                                       |
| ------------------------------------- | -------------- | ------------------------------------------- |
| Limites de conexão do plano Neon      | engenharia     | sonda Fase 0.3 (branch efêmera + SHOW/CLI)  |
| Cold-start Neon (time-to-first-query) | engenharia     | sonda Fase 0.3 (3 amostras, timestamps)     |
| Domínio de produção + TTL             | humano/hPanel  | sem nome documentado; dig/TTL após registro |
| Alvo de cold start (threshold)        | programação B3 | valor 0h registrado; alvo fixado em B3      |

## Cobertura

11/11 itens mapeados: 1→H-01 · 2/3/4→H-02 · 5→H-03 · 6→H-03/H-08 · 7→H-09 ·
8→H-04 · 9→H-05 · 10→H-10 · 11→H-11/H-14. Smoke A4: a→H-07 · b→H-12/H-13 ·
c→H-03/H-04/H-08 · d→H-09/H-11/H-14 · e→H-06 + baseline 0h (latência 3
amostras, contagens por tabela, journal hash, stats de pool, contadores de
erro de log). Nenhum H sem sonda desenhável; H-06/H-08 dependem dos parâmetros
medidos na Fase 0.3 (declarados acima com dono).
