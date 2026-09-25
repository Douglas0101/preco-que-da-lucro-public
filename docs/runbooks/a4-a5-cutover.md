# Runbook — A4 primeiro deploy + A5 vigilância 0h/24h/72h

> Complementa `migracao-supabase-neon.md` (cutover de dados) e `hpanel-homologacao.md` (pré-requisito 11/11 PASS). Cutover = **primeiro tráfego real** (não há runtime anterior).

## A4 — sequência (~1 dia)

1. **Pré-deploy (ordem obrigatória):** (i) snapshot externo verificado (`npm run m02:backup-verify`: `dump.pgc` + sha256 + drill PASS); (ii) snapshot nativo Neon (registrar ID + validade; ref `snap-tiny-smoke-ayc382ji` até 2026-10-10 — renovar se expirada); (iii) `npm run build` do SHA de `main` + `npm run check:hostinger-runtime` verde; (iv) hPanel 11/11 PASS.
2. **Deploy:** artefato do SHA publicado; start `npm run start`; conferir `ps` + logs (porta/host efetivos).
3. **Smoke A4 (bloqueante):** `curl -i https://<domínio>/api/health/live` → 200; `.../ready` → 200; `npm run smoke:substrate` verde (major 17, journal/hashes, `app_runtime` sem superuser/BYPASSRLS, RLS, `issuer IS NULL` = 0, `production-fixture-free`); login conta controlada + senha errada rejeitada + logout/relogin + sem sessão bloqueado; better-auth 1.7.x com issuer preenchido.
4. **Registrar ledger A5** (template abaixo) com `deployed_at` e `smoke_passed_at` UTC. Sem os dois carimbos, A5 não inicia.

## A5 — 0h / 24h / 72h

**0h (pós-smoke):**

```bash
date -u +%FT%TZ   # deployed_at / smoke_passed_at
npm run smoke:substrate   # PASS 7/7 (read-only)
curl -i https://<domínio>/api/health/live; curl -i https://<domínio>/api/health/ready
```

```sql
SELECT count(*) AS issuer_null FROM accounts WHERE issuer IS NULL;  -- esperado 0
SELECT count(*) AS accounts_total FROM accounts;  -- base da guarda 0010
```

**24h:** repetir smoke + ready; `issuer_null` = 0; zero spike de 401 vs 0h; `rate_limits`/429 sem anomalia; latência `app.*` sem regressão; sem P0/P1.

**72h:** repetir 24h na janela completa + reconciliação contábil leve:

```sql
SELECT 'users' t, count(*) FROM users UNION ALL SELECT 'accounts', count(*) FROM accounts
UNION ALL SELECT 'tenants', count(*) FROM tenants UNION ALL SELECT 'products', count(*) FROM products;
```

Decisão final: manter Neon como destino único; origem congelada (ADR-021 §9).

**Abort (qualquer um dispara rollback):** erro financeiro crítico ou cross-tenant; `ready` 5xx > 15 min; spike de 401; divergência financeira inexplicada; `smoke:substrate` FAIL em qualquer reexecução.

**Rollback:** pré-escrita → restaurar secrets/runtime anterior; pós-escrita → manutenção + restore do **snapshot pré-deploy** (nativo + `dump.pgc`; PITR 6h é camada adicional — BAK-01 aberta). **Nunca** `0010_to_0009_down.sql` com contas presentes (a guarda aborta por desenho; rollback de issuer pós-tráfego = snapshot). Sem dual-write; sem copiar escritas à origem.

## Template de ledger A5 (UTC ISO-8601)

```markdown
| janela | deployed_at | smoke_passed_at | live | ready | issuer_null | accounts_total | 401_spike | 429_anomalia | latencia_ok | smoke_substrate | P0_P1  | decisão                         |
| ------ | ----------- | --------------- | ---- | ----- | ----------- | -------------- | --------- | ------------ | ----------- | --------------- | ------ | ------------------------------- |
| 0h     | 2026-..T..Z | 2026-..T..Z     | 200  | 200   | 0           | N              | n/a       | n/a          | n/a         | PASS 7/7        | nenhum | A5 iniciada                     |
| 24h    | —           | —               | 200  | 200   | 0           | N              | não       | não          | sim         | PASS 7/7        | nenhum | manter / abortar                |
| 72h    | —           | —               | 200  | 200   | 0           | N              | não       | não          | sim         | PASS 7/7        | nenhum | destino único; origem congelada |
```
