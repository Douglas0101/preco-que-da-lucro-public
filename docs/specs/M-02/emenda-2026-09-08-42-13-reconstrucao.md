# Emenda 2026-09-08 — Migração por reconstrução: §42 itens 2,3 N/A-por-decisão; §§13.4/13.6 com semântica de reconstrução

- **Data:** 2026-09-08 · **Tipo:** addendum datado ao plano canônico (não reescreve o canônico).
- **Causa:** FATO NOVO de proveniência — stack de origem = Lovable com Supabase
  primário, custódia de terceiro (sócio). Handover = arquivos do sistema +
  algoritmos fontes. NÃO recebido: credenciais Supabase, conta Lovable, export
  de dados; custódia do domínio A VERIFICAR.
- **Decisão embutida ratificada:** migração POR RECONSTRUÇÃO; D2 FECHADO
  (inobtenível por custódia); V2b APOSENTADO com registro; G1(a) assinável com
  causa CUSTÓDIA (não "abandono"); SUNSET 20/09 DISSOLVIDO.
- **Âncoras canônicas:** Plano Mestre §42 (`:2166-2177`), §13.4 (`:1149-1158`),
  §13.5 (`:1160-1170`), §13.6 (`:1172-1182`), §13.7 (`:1184-1191`), §12.1 (`:1032-1046`).

## 1. §42 itens 2,3 → N/A-por-decisão

- Item 2 (`migrations em cópia de produção`) e item 3 (`schema diff revisado`),
  na acepção legado×Neon, passam a **N/A-por-decisão G1(a) 2026-09-08**.
  Não são PASS nem FAIL: não há origem auditável contra a qual copiar/diferir.
- O `schema diff` Neon×restore em branch de drill permanece OBRIGATÓRIO como
  prova de mecanismo (já exercitado em C-02/C-02A), sem jamais ser promovido a
  paridade legacy.
- Item 6 (`reconciliation report` §13.5) na acepção legado×Neon: N/A-por-decisão;
  o relatório Neon×restore permanece obrigatório como prova de mecanismo.

## 2. §§13.4/13.6 com semântica de reconstrução

- §13.4 (data migration por tabela): sem objeto — não há dados de origem a
  validar. Substituído por baseline = Neon atual fixture-free + journal 11/11.
- §13.6 (cutover): janela de freeze, última sincronização e "manter origem
  somente leitura durante rollback window" são N/A-por-decisão. Cutover =
  primeiro tráfego real (deploy + smoke). Validação, troca de secret, smoke,
  monitorar e rollback documentado permanecem obrigatórios.
- Fase C do programa (decommission da origem) vira **declaração de limite de
  custódia**: o programa não desliga o que nunca foi seu; o encerramento da
  origem = pedido registrado ao sócio (template E3, não-bloqueante).

## 3. Cláusula residual (reversibilidade sem sunset)

- Manifestação posterior de dado real → rodada de import ad hoc, com escopo
  declarado; V2b ressuscita pontualmente para esse escopo.
- Sem manifestação, a reconstrução permanece válida; não há caducidade por data.

## 4. O que NÃO muda

- BAK-01a (restore/RLS, H-07 PASS exigido, PS-S5 bloqueado até lá) e BAK-01b
  (PITR ≥7d antes do dia-D) seguem abertas e inalteradas.
- N-10 permanece verbatim no ledger. Selos PS-S1/PS-S6 invioláveis.
- Produção read-only; sem commits (H1 é a ponte); sondas FAIL-LOUD.
