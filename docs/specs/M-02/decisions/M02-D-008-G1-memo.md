# Memo — M02-D-008: estado da origem Supabase (resolução PROPOSTA → ASSINADA)

- **Data:** 2026-09-06 · **Tipo:** RFC curta (fato/decisão/impacto) · **Estado:** RASCUNHO para assinatura G1
- **Refs:** `docs/specs/M-02/decisions/M02-D-008.md` · `docs/evidence/substrato-2026-09-05/report.md` §2.2/§3 · `docs/runbooks/migracao-supabase-neon.md` (cutover) · `ADR-021` §5–9 · `.github/workflows/ui-stack.yml`

## 1. Fato

- **Destino Neon:** em 2026-09-05 production continha só fixture — 4 contas probe/QA criadas 2026-08-30, 1 produto, 2 despesas, 1 conversa, 2 sessões, zero usuário real. **Purge executado 2026-09-06: 26/26 tabelas zero, smoke 7/7.** Purge é válido em ambos os ramos.
- **Origem Supabase DESCONHECIDA:** sem `SUPABASE_MIGRATION_DATABASE_URL` nos secrets CI; `curl *.supabase.co → 000` (não autenticado, rede única — limite da evidência); runbook: "o projeto nunca rodou oficialmente no Supabase".
- **Runtime sem Supabase (CONFORME):** gate `check:no-supabase-runtime` ativo em `ui-stack.yml`; `grep @supabase|supabase.co|createClient` em `src/` = vazio.
- **Paridade é DESCONHECIDA até assinatura.** Inferir origem vazia a partir do destino vazio é **proibido** (M02-D-008 §3).

## 2. Decisão recomendada — opção (a): origem abandonada → greenfield

Assinar que a origem Supabase é **abandonada / sem tráfego oficial**, encerrando o requisito de paridade ADR-021 §6. Cutover = primeiro tráfego real (deploy + smoke), sem freeze/delta (M02-D-008 impacto; runbook `provisionamento limpo`).

### Cláusula SUNSET

- Esta atestação **caduca em 2026-09-20T23:59Z ou no A4, o que ocorrer primeiro**, se antes disso surgir **evidência contrária**.
- **Evidência contrária que revoga (qualquer uma):** (i) `SUPABASE_MIGRATION_DATABASE_URL` read-only funcional com `SELECT` mostrando usuários/dados reais; (ii) fatura/logs Supabase provando tráfego oficial; (iii) código/env provando runtime Supabase em produção.
- Revogada → rota flipa para (b) automaticamente; passada a data sem evidência → greenfield trava, reabertura só por nova decisão.

## 3. Impacto

- **Se (a) assinada:** fase C vira **abandonment attestation** — nova categoria documental `ABANDONMENT-ATTESTATION`, formato `docs/evidence/abandonment/attestation.md` (declarante, data, buscas executadas, declaração "sem tráfego/dados reais", SUNSET acima). Sem freeze, sem relatório §6.
- **Se (b) (origem existe, reconciliar):** registra-se novo blocker externo `BLOCKER-EXT-02` (acesso read-only Supabase); freeze, delta/re-sync e relatório `different=0, sessionsImported=0, zero órfãos` (ADR-021 §5–7) voltam a ser obrigatórios; A4 bloqueado até `different=0`.
- Em ambos: guarda do down 0010 já recontada pós-purge; retenção §9 (14 dias) só se aplica a (b).

## 4. Riscos

- **Riscos de (a):** origem real esquecida ressurge pós-A4 (dados órfãos/reclamação) — mitigado pelo SUNSET + buscas documentadas; falso greenfield se credencial existir e não foi procurada — mitigado por checklist de secrets antes de assinar.
- **Riscos de (b):** origem inacessível trava A4 por semanas por dado que o runbook diz nunca ter existido; custo de freeze/reconciliação sobre vazio; credencial read-only alarga superfície de segredo sem benefício provado.

## 5. Recomendação

Assinar **(a)** com SUNSET acima. Custo de (b) é certo, benefício é especulativo; SUNSET preserva reversibilidade.

## 6. FATO NOVO de proveniência (2026-09-08) — causa CUSTÓDIA

- **FATO 1:** origem = Lovable + Supabase primário, custódia de terceiro (sócio).
- **FATO 2:** handover = código + algoritmos; sem credenciais Supabase, sem conta
  Lovable, sem export de dados. D2 FECHADO (inobtenível por custódia).
- **FATO 3:** a evidência `curl 000` sempre foi fraca — SUPERSEDIDA pelo fato de
  custódia acima.
- **DECISÃO:** migração por reconstrução; paridade NÃO-APLICÁVEL por design;
  V2b APOSENTADO (ressuscita pontualmente só em rodada de import ad hoc).
  SUNSET 20/09 DISSOLVIDO (decisão baseada em fato, não em espera).
- **Redação da assinatura:** G1(a) com causa CUSTÓDIA (não "abandono").
  Declaração do sócio (template E3) = endurecimento não-bloqueante.
- **Refs:** `M02-D-008-E3-declaracao-socio-template.md` ·
  `M02-D-008-E4-nota-proveniencia-template.md` ·
  `emenda-2026-09-08-42-13-reconstrucao.md`.

---

## G1 SIGNATURE

- Nome (humano, legível): Douglas
- Data (UTC): 2026-09-12T02:43:00Z
- Opção: [x] (a) origem abandonada → greenfield com SUNSET 2026-09-20 · [ ] (b) origem existe → BLOCKER-EXT-02 + reconciliação ADR-021 §6
- Assinatura: Douglas
- Nota de auditoria: assinatura transcrita por delegação explícita do operador em sessão (2026-09-12T02:43Z), com autorização registrada no ledger.
