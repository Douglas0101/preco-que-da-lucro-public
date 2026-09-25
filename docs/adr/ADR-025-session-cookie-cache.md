# ADR-025 — Cache de sessão por marker assinado (revisão da política de ADR-020)

- Status: **aceito (ACCEPTED)** — decisão humana do owner em 2026-08-30
- Decisão: **Opção A aceita** (marker de sessão assinado, TTL ≤ 60s, sem novas dependências), com as 6 condições obrigatórias como critérios de aceite e gate de sequenciamento para a implementação (S5). Registro completo no fim deste documento.
- Data: 2026-08-29
- Escopo: autenticação do BFF (revisão pontual do item 3 de ADR-020)
- Originado por: ONDA 0 / S0-BASELINE (baseline F0-04, dev-evidence em `docs/evidence/perf-baseline-2026-08-29.md`)

## Contexto

ADR-020 deliberou, por segurança, que "cookie cache de sessão fica desabilitado. Cada validação privada consulta a sessão revogável no PostgreSQL". Hoje isso está materializado em dois pontos:

- `src/server/auth/auth.server.ts:33` — `session.cookieCache: { enabled: false }`
- `src/middleware/request-context.ts:47` — `getAuth().api.getSession({ ..., query: { disableCookieCache: true } })` (bypass explícito mesmo se o cache global fosse ligado)

Consequência medida (dev-evidence, 2026-08-29, NÃO é produção): `GET /api/auth/get-session` custa p50 ≈ 2316ms e max 3436ms por invocação, e **toda server function privada é precedida por um get-session** (padrão de waterfall registrado no baseline). Cada invocação paga ≥2 RTs Neon só para revalidar uma sessão opaca que raramente muda entre requisições do mesmo usuário. O diagnóstico aceito do programa PERF/FIN identifica a taxa fixa de ~8–10 RTs Neon por server function (~0,5s/RT) como gargalo dominante; o custo de sessão é parte fixa desse imposto em cada request privado.

O custo de segurança desse desenho é deliberado (revogação imediata). A questão desta revisão: existe um mecanismo de cache que preserve revogação com janela limitada, explícita e auditável, sem novas dependências?

## Opções

### Opção A — Habilitar marker de sessão assinado com TTL ≤ 60s (aprovada condicionalmente abaixo)

Introduzir, no caminho de leitura de sessão, um marker curto-vidro: após uma validação completa no PostgreSQL, emitir um marker assinado (HMAC via `node:crypto` — **zero novas dependências**) contendo no mínimo `userId`, `sessionId`, `tenantId` efetivo, `iat` e `exp` (TTL ≤ 60s). Requisições dentro do TTL podem confiar no marker para a etapa de _autenticação_; a _autorização_ (membership/tenant) continua seguindo INV-002/010 (verificação server-side antes de qualquer SET LOCAL de GUCs de tenant; RLS preservada). Escritas NUNCA usam o marker (ver condições).

### Opção B — Rejeitar a revisão

Manter ADR-020 integralmente. Justificativa legítima: consistência de revogação imediata vale ~2 RTs/request. Custo: o imposto fixo de sessão permanece em toda a superfície privada e as otimizações de ondas seguintes ficam restritas a consolidar queries de dados, sem tocar o custo de sessão.

### Opção C — Adiar

Reavaliar após S1 (instrumentação de RT-count) provar, com medição e não estimativa, quanto dos RTs por request é sessão. Custo de adiar: decisões de S1+ ficam cegas para a maior alavanca isolada de latência percebida; custo de reabrir depois: retrabalho de onda.

## Tradeoff de revogação (aplica-se à Opção A)

- Janela de revogação deixa de ser 0 e passa a ser **≤ TTL do marker (≤ 60s)**: um `logout`/revogação seguido de request imediato pode ser atendido pelo marker ainda válido.
- Mitigações obrigatórias (ver condições): escritas e operações sensíveis ignoram o marker; TTL máximo fixado em código e em teste; logout do próprio usuário invalida o marker local imediatamente (cookie/driver), reduzindo a janela prática para o caso mais comum.
- O tradeoff é explícito e mensurável: ganho de ~2 RTs/request privado vs. janela de revogação ≤ 60s apenas para leituras.

## Condições OBRIGATÓRIAS se a Opção A for aceita

1. **HMAC via `node:crypto`** (ex.: HMAC-SHA256 com `BETTER_AUTH_SECRET` ou segredo dedicado); proibido introduzir dependência em `package.json`.
2. **Teste REVOCATION**: logout → request imediato com o marker emitido antes do logout deve FALHAR na primeira operação não-cacheável (ou, no pior caso aceito, dentro de ≤ TTL; o teste deve fixar o limite superior).
3. **Teste FORGERY**: marker sem assinatura, com assinatura inválida, expirado ou com campos divergentes (`userId`/`sessionId`/`tenantId`) deve ser REJEITADO e tratado como não-autenticado.
4. **Escritas mantêm validação na tx**: toda server function de escrita (upsert/delete/mutação) e todo caminho que executa `SET LOCAL` de GUCs de tenant validam a sessão diretamente no PostgreSQL na mesma transação, ignorando o marker (INV-002/010, RLS preservada).
5. TTL ≤ 60s, hardcoded com constante nomeada e coberto por teste (não configurável para cima sem novo ADR).
6. Membership continua resolvida do banco para autorização; o marker nunca autoriza tenant por si só.

## Consequências

- Se aceita: reduz o imposto fixo de sessão por request privado (dev-evidence sugere até ~2s/request em dev); introduz janela de revogação ≤ 60s apenas para leituras; exige os 6 itens acima como critérios de aceite do PR implementador.
- Se rejeitada/adiada: ADR-020 permanece inalterado; o custo de sessão permanece e deve ser tratado como constante aceita do sistema (documentar no próximo baseline).

## Referências

- ADR-020 — Better Auth e sessões server-driven (item 3: cookie cache desabilitado)
- `docs/evidence/perf-baseline-2026-08-29.md` (dev-evidence; get-session p50 2316ms, n=12)
- Diagnóstico aceito do programa PERF/FIN 2026-08-29 (gargalo = RTs fixos por server function + waterfalls)

## Decisão registrada — 2026-08-30

- **Decisão: accept** (Opção A — marker de sessão assinado com TTL ≤ 60s)
- **Por:** Douglas Souza — owner de governança
- **Data:** 2026-08-30T01:56:00-03:00
- **Checklist de condições confirmado pelo owner** (critérios de aceite do PR implementador):
  - [x] HMAC via `node:crypto` — zero novas dependências (condição 1)
  - [x] TTL ≤ 60s, constante nomeada, hardcoded com teste (condições 2 e 5)
  - [x] Teste REVOCATION com limite superior fixado (condição 2)
  - [x] Teste FORGERY/assinatura inválida rejeita e trata como não-autenticado (condição 3)
  - [x] Escritas e `SET LOCAL` validam sessão na própria transação, ignorando o marker (condição 4)
  - [x] Membership/autorização sempre resolvida do banco; marker nunca autoriza tenant (condição 6)
- **Gate de sequenciamento:** a implementação (S5) SOMENTE após o commit das ondas
  PERF/FIN (2026-08-29/30) — misturar mudanças de auth ao worktree de 43 entradas de
  origens mistas degradaria a atribuição de drift.
- **Evidência de base:** dev-evidence (`docs/evidence/perf-baseline-2026-08-29.md`,
  get-session p50 ≈ 2316ms, n=12) — NÃO é prova de produção.
