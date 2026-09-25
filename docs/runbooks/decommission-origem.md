# Checklist — Decommission da origem (14 dias, ADR-021 §9)

> Origem **congelada por 14 dias** contados de `smoke_passed_at`. Desativação/exclusão **só com aprovação explícita do owner**. BAK-01 deve estar encerrada ou com compensatórios vigentes no ato. Sem `smoke_passed_at`, este checklist não inicia.

## Variante A — condicionada a G1(a): provisionamento limpo · formato: atestação de abandono

- [ ] Ledger contém ratificação humana de provisionamento limpo (paridade encerrada; sem freeze/delta).
- [ ] Atestação de abandono assinada: _"Atesto que a origem Supabase [projeto-ref] nunca serviu tráfego oficial, que nenhum dado real reside nela, que o Neon é o destino único desde [smoke_passed_at], e autorizo a desativação em [data ≥ D+14]."_ (nome, data UTC, assinatura).
- [ ] Inventário da origem anexado (contagens ou declaração de vazio) + mapa segredo→consumidor sem apontar para ela (DB-02/SEC-01).
- [ ] Backup final da origem arquivado (dump + sha256, 2 gerações, fora do git) antes de desativar.
- [ ] Desativação após D+14 + `ready=200` sem a origem + encerramento no ledger.

## Variante B — para G1(b): origem com dados · formato: verificação/exportação

- [ ] Credencial read-only `SUPABASE_MIGRATION_DATABASE_URL` + reconciliação ADR-021 §6 (contagens, nulos, timestamps, somas, órfãos, checksums; `different=0`, zero órfãos, `sessionsImported=0`).
- [ ] Relatório de reconciliação arquivado + gate "diferença zero ou exceção aprovada" assinado.
- [ ] Freeze + delta/re-sync documentados (export final, import `MIGRATION_APPLY=true`, re-reconciliação).
- [ ] Exportação final arquivada (dump + sha256, 2 gerações) + zero imports/SDK/vars/tokens Supabase no executável.
- [ ] Após D+14 + aprovação explícita: desativar; `ready=200` sem a origem; encerramento no ledger.
