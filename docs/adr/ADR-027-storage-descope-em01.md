# ADR-027 — Desescopo de Storage do cutover (EM-01)

- **ID:** ADR-027 · **Rastro:** EM-01 ← M02-D-006 (PROPOSTA) · **Data:** 2026-09-06
- **Estado:** PROPOSTA (aguarda assinatura G2; sem implementação)
- **Tipo:** GAP-DOC / decisão de escopo

## 1. Fato

1. Nenhuma cláusula normativa define o sucedente do Supabase Storage (M02-D-006 §Fato).
2. Zero código de object-storage em `src/` (`grep AWS/S3/bucket/upload/presign` = só falsos positivos de rate-limit/latência).
3. `products` (`src/db/schema.ts:191-230`) não tem coluna de imagem; `users.image` (`:46`, Better Auth, avatar opcional) não tem consumo em UI.
4. `neon-storage.env` (5 chaves órfãs) removido do disco em 2026-09-05T19:58:45Z; zero consumidores; revogação no emissor pendente-humano (SEC-01).
5. Errata M02-D-006 (2026-09-06): onde se lia `products.image` (`schema.ts:46`), leia-se `users.image`; `products` não tem coluna de imagem.

## 2. Matriz normativa

| Fonte                           | Cláusula de storage                  | Veredito          |
| ------------------------------- | ------------------------------------ | ----------------- |
| SDD (incl. §21.1)               | só auditoria da surface legada       | nada normativo    |
| Plano Mestre §§39/42/43/44/46   | sem exigência de arquivos/buckets    | nada normativo    |
| V7 · ADR-019/020/021/023 · M-02 | sem definição de provedor de objetos | lacuna confirmada |

Não existe requisito de storage a cumprir no cutover; introduzir provedor seria requisito novo.

## 3. Dependências e A4

Nenhuma feature (produtos, vendas, despesas, simulações, chat, auth, E2E, smoke, deploy) depende de storage. A4 não precisa de storage; reintroduzir chaves S3 no cutover ampliaria a superfície durante a janela SEC-01.

## 4. Alternativas (pós-B4, quando houver demanda real)

| Alt.                             | Custo                | Risco                                              | Operabilidade |
| -------------------------------- | -------------------- | -------------------------------------------------- | ------------- |
| A. S3-compatível genérico        | baixo–médio (egress) | médio (segredos, presign, CORS, isolamento/tenant) | média         |
| B. R2 (egress zero)              | baixo                | baixo–médio                                        | média-alta    |
| C. Objetos do provedor de deploy | baixo                | baixo                                              | alta          |
| D. Diferir (padrão)              | zero agora           | mínimo                                             | máxima        |

Escolha futura exige RFC própria (isolamento/tenant, URLs assinadas, LGPD, lifecycle, backup, sem segredos de longa vida).

## 5. Decisão (RECOMENDAÇÃO)

1. Storage fora do cutover; nenhum requisito novo ao A4/A5 (ratifica M02-D-006 §1).
2. Sem bucket/SDK/presign/coluna/segredos S3 no cutover; `neon-storage.env` segue deletado.
3. SEC-01 fecha antes de produção, sem reintroduzir as chaves.
4. M-05/M-07 herdam este ADR quando surgir funcionalidade de arquivos.
5. Gate inalterado: auditoria da surface legada (SDD §21.1).

## 6. G2 SIGNATURE

- Aprovador (humano): ____________________ · Data: ____________________
- Efeito: PROPOSTA → RATIFICADO; desescopo vigente no gate A4/A5; RFC de provedor pós-B4.
- Sem assinatura: vale PROPOSTA; norma vigente segue M02-D-006.
