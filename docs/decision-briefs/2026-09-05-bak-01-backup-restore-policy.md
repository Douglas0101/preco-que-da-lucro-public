> SUPERSEDIDA em 2026-09-05: esta proposta histórica não comprova RPO nem conformidade integral. A política corrigida está em `../evidence/pre-a4-2026-09-05/implementation/backup.md`.

# Emenda de política BAK-01 — backup/restore pré-A4

- **Data:** 2026-09-05 · **Tipo:** VIOLAÇÃO → exceção com controles compensatórios + emenda normativa · **Estado:** ATIVA (exceção) / VIGENTE (política)
- **Evidência de origem:** drill `m02:backup-verify` em 2026-09-05T20:24:20Z (`docs/evidence/pre-a4-2026-09-05/backup-restore-drill.json`)

## Fato

A spec exige: Plano Mestre §42 ("backup/restore testado" como gate antes de Neon
production), SDD NFR-RES-003 (RPO ≤ 15 min, RTO ≤ 4 h), SDD §2446 (**PITR mínimo
de 7 dias obrigatório em produção; indisponibilidade exige controle alternativo
capaz de cumprir RPO 15 min**) e SDD §2998 ("backup independente e restauração
isolada comprovam RPO/RTO").

O estado medido do plano Neon atual: retenção de histórico de **6 horas** e
**zero snapshots gerenciados** (auditoria 2026-09-05). Ou seja, o requisito de
PITR ≥ 7 dias **não é suportado pelo plano vigente** e nenhum controle
alternativo existia. Classificação: **VIOLAÇÃO** de SDD §2446 (a spec prevê o
caso de indisponibilidade e exige controle alternativo — que não existia).

## Decisão (política vigente a partir desta data)

1. **Snapshot externo pré-deploy é obrigatório.** Antes de qualquer deploy com
   tráfego (A4) ou escrita destrutiva (ex.: purge DB-01), executar
   `npm run m02:backup-verify` com `DATABASE_ADMIN_URL` (URL direct): o script
   produz `pg_dump` custom em `.artifacts/backup-drill/<ts>/dump.pgc` com
   sha256 registrado e **só é válido se o restore de verificação passar**
   (backup não restaurado é esperança, não backup).
2. **Procedimento de restore comprovado** (drill desta rodada): dump custom →
   `CREATE DATABASE drill_restore_<ts>` → `pg_restore --no-owner --no-privileges`
   → verificação (contagens por tabela, journal de migrations reconciliado
   hash-a-hash, RLS em tabelas tenant, policies) → `DROP DATABASE`. Limite
   declarado: ownership/GRANTs não são restaurados (objetos internos Neon
   pertencem a roles de serviço como `neon_service`); o drill cobre dados,
   schema, RLS e constraints — que é o que o rollback pós-escrita consome.
3. **Cadência:** a cada deploy com mudança de schema ou antes de qualquer
   operação destrutiva; fora isso, semanal enquanto o plano não oferecer PITR ≥
   7 dias. Retenção dos dumps locais: mínimo de 2 gerações fora do git
   (`.artifacts/` é gitignored).
4. **Rollback pós-escrita** (ADR-021 §8: "Depois da primeira escrita no Neon,
   snapshot/PITR"): o artefato desta política é o `dump.pgc` verificado +
   restore no banco efêmero; PITR do Neon (6 h) permanece como camada
   adicional, não como controle primário.

## Exceção BAK-01 (rastro da VIOLAÇÃO)

- **ID:** BAK-01 · **Aberta:** 2026-09-05 · **Fase-alvo de encerramento:** até
  o deploy A4 (avaliar upgrade de plano Neon com PITR ≥ 7 dias ou solução de
  backup gerenciado equivalente).
- **Razão rastreável:** plano Neon atual limita histórico a 6 h e não expõe
  snapshots gerenciados; o tráfego ainda não existe (cutover = primeiro
  deploy), então o RPO 15 min não tem dados de tráfego a proteger até A4.
- **Controles compensatórios (obrigatórios enquanto BAK-01 ativa):**
  (i) snapshot externo verificado por restore antes de A4 e de qualquer
  operação destrutiva; (ii) cadência semanal manual; (iii) checagem da
  capacidade de snapshot nativo via workflow `neon-drill-ops`
  (`snapshot-list`/`snapshot-create`) — se o plano passar a suportar, a exceção
  é reavaliada no mesmo dia; (iv) restore drill repetível via
  `npm run m02:backup-verify`.

## Impacto

- §42 do Plano Mestre passa de "não comprovado" para **comprovado por drill
  externo** (evidência ligada acima), com a ressalva explícita de que PITR ≥ 7
  dias depende de mudança de plano/controle gerenciado (BAK-01).
- Nenhuma mudança de código de runtime, schema ou dados.
