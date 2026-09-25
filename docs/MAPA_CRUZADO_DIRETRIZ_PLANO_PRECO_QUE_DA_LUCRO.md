# Preço que Dá Lucro — Mapa Cruzado: Diretriz de Precificação × Plano Mestre Validado

| Campo  | Valor                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Data   | 2026-08-08 (reavaliação V7 em 2026-08-09)                                                                                               |
| Fontes | `docs/DIRETRIZ_PRECIFICA_PRECO_QUE_DA_LUCRO.md` (Diretriz) e `docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md` (Plano) |
| Apoio  | `docs/ARQUITETURA_CONSOLIDADA_PRECO_QUE_DA_LUCRO.md` (Arquitetura)                                                                      |
| Escopo | Somente leitura cruzada; nenhum documento-fonte foi alterado                                                                            |

> **Nota de superseding (2026-08-09):** a Diretriz original foi substituída por `docs/DIRETRIZ_PRECIFICA_PRECO_QUE_DA_LUCRO_V7_SHADCN_BASEUI_SINCRONIZADO_OFICIAL.md` (V7), diretriz consolidada de produto, arquitetura e engenharia. As seções 1–4 abaixo permanecem como registro histórico do cruzamento contra a Diretriz pré-V7; a seção 5 (R1–R8) foi reavaliada contra a V7 na seção 6.

## 1. Propósito e método

Cruzamento sistemático entre a especificação de domínio (Diretriz, 17 seções) e o plano de engenharia validado (Plano, fases F0–F15, prioridades P0/P1/P2, invariantes INV-001..015), para confirmar cobertura, expor lacunas e registrar conflitos antes da implementação das fases.

Critérios de classificação:

- **coberto** — o Plano/Arquitetura trata o requisito de forma explícita e acionável.
- **parcial** — há cobertura de direção ou de mecanismo, mas falta detalhe de domínio exigido pela Diretriz.
- **lacuna** — nenhuma fase, item ou invariante cobre o requisito.
- **conflito** — os documentos apontam direções incompatíveis.

Decisão de escopo registrada em 2026-08-08: o produto é voltado **exclusivamente ao setor de alimentação**. Isso prevalece sobre dois trechos da Diretriz: a abertura ("especialmente negócios de alimentação, mas estruturado para futuramente atender outros segmentos") e a expansão "mais categorias de negócios" (§17). As demais expansões de §17 permanecem como backlog futuro dentro do setor de alimentação.

## 2. Matriz de rastreabilidade

| Diretriz                   | Plano (fase/item)                                                                  | Arquitetura       | Classe  | Observação                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| §1 Identidade e UX         | F13 (§18: estados explícitos, badges, explain, skeleton)                           | §4.1–4.2          | coberto | Navegação de 7 itens e dashboard-resumo correspondem aos módulos de §4.2                               |
| §2 Cadastro conversacional | F9 (§14: Conversation FSM, tool allowlist, ToolExecution), P0#13                   | §9                | coberto | "Uma pergunta por vez" e confirmação de dados alinham com a FSM e o estado persistente                 |
| §3 Custo dos ingredientes  | F5 (§10: Money, Quantity), FIN-006, P0#8 (conversão incompatível)                  | §7–8              | coberto | "Nunca inventar conversões inseguras" ≡ política de conversão incompatível do P0                       |
| §4 Rendimento da receita   | F5 (§10), FIN-006 (unit model), P0#7 (yield/tax defaults)                          | §8                | coberto | Rendimento como Quantity explícita; defaults de yield removidos no P0                                  |
| §5 Embalagem e materiais   | F5 (§10), F6 (§11: schema)                                                         | §7                | parcial | Custo de embalagem coberto; "outros materiais" (sacola, lacre, talher) sem modelagem explícita         |
| §6 Formação de preço       | F5 (§10), FIN-005 (markup arbitrário), P0#6                                        | §8                | parcial | Regra MEI/DAS como despesa fixa e "não inventar alíquotas" sem item dedicado no Plano                  |
| §7 Margem de contribuição  | F5 (§10), F13 (§18.3 explain calculation)                                          | §8                | coberto | Didática "não confundir markup/margem/lucro" atendida pelo explain e badges                            |
| §8 Preço de mercado        | F6 (§11.6 price history), P1#8                                                     | §4.2, §6.2        | parcial | Comparação visual custo/preço/mercado e análise "% acima/abaixo" sem especificação de UX               |
| §9 Despesas da empresa     | F4 (§9: Expense Service), F6 (§11)                                                 | §6.3              | coberto | Categorias, tipos fixa/variável e periodicidade mapeáveis ao service e schema                          |
| §10 Ponto de equilíbrio    | F5 (§10), ARQ §8.5 dedicado                                                        | §8.5              | coberto | Unidades e faturamento ambos previstos                                                                 |
| §11 Meta de lucro          | F5 (§10)                                                                           | §8                | coberto | `calculateRequiredSalesForProfit` corresponde à fórmula da Diretriz                                    |
| §12 Simulações             | F6 (§11.8 simulations), P1#11 (persistência)                                       | §6.5              | coberto | Cenário atual × simulado com impacto em margem/break-even/lucro                                        |
| §13 Diagnóstico financeiro | F4 (§9: Diagnostic Service)                                                        | §6.6              | parcial | Serviço existe; as 7 regras de alerta e a linguagem hedged ("vale investigar") não estão especificadas |
| §14 Estrutura do banco     | F6 (§11: PK/tenant, CHECK, nullability, RLS), F8 (§13: migração), P1#9–10, INV-008 | ADR-001/005 (§82) | parcial | Direção coberta; as 12 entidades nomeadas não têm mapeamento uma-a-uma no schema-alvo                  |
| §15 Regras financeiras     | F5 (§10: Money/Percent/Quantity/snapshot), P1#5 (Money decimal), INV-004/006/007   | §8.1–8.4          | parcial | As 11 funções nomeadas e a formatação pt-BR (`R$ 1.234,56`, `10,00%`) não são contrato explícito       |
| §16 IA conversacional      | F9 (§14), IA-001 (P0#9: Zod em tools), P0#14–15 (audit, timeout/budget)            | §10–11            | coberto | "Nunca inventar valores/preços/impostos/custos" ≡ regras de IA da Arquitetura                          |
| §17 MVP e expansões        | Ordenação F0–F15 (§4, §40)                                                         | §75–80            | lacuna  | Estoque, fluxo de caixa, DRE, ranking, WhatsApp e planos não têm fase — backlog futuro deliberado      |

## 3. Lacunas e parcialidades detalhadas

1. **Formatação pt-BR de apresentação (Diretriz §15)** — a Diretriz exige `R$ 1.234,56` e percentuais `10,00%`; o Plano trata precisão interna (Money decimal, Percent) mas não fixa a camada de formatação de exibição. Classe: lacuna de detalhe.
2. **Contrato das 11 funções financeiras (Diretriz §15)** — `calculateIngredientCost()` … `calculateScenario()` devem existir como funções determinísticas nomeadas; o Plano define o Financial Engine sem nomear esse contrato de API. Classe: parcial.
3. **Regra tributária MEI/DAS (Diretriz §6)** — DAS como despesa fixa/operacional mensal (não variável por produto) e proibição de presumir alíquotas; o P0 remove markup arbitrário e yield defaults, mas não registra a regra MEI/DAS. Classe: lacuna de detalhe.
4. **Outros materiais diretos (Diretriz §5)** — entidade `OTHER_DIRECT_COSTS` existe na Diretriz §14; o Plano não cita materiais além de embalagem. Classe: parcial.
5. **Regras de alerta do diagnóstico (Diretriz §13)** — 7 gatilhos de alerta e tom de linguagem ("vale investigar", "os dados indicam") sem contrapartida no Diagnostic Service. Classe: parcial.
6. **Comparação visual de mercado (Diretriz §8)** — visual custo × preço atual × sugerido × médio de mercado sem item de UX dedicado. Classe: parcial.
7. **Mapeamento das 12 entidades (Diretriz §14)** — `USERS … FINANCIAL_DIAGNOSTICS` precisam de correspondência explícita no schema PostgreSQL-alvo (F6). Classe: parcial.
8. **Expansões pós-MVP (Diretriz §17)** — controle de estoque, fluxo de caixa, DRE simplificada, comparação/ranking de produtos, WhatsApp, plano gratuito/pago. Sem fase no Plano; coerente com "não construir agora", mas devem constar como backlog registrado. Classe: lacuna (deliberada). Recorte: "outras categorias de negócio" está **fora** por decisão de 2026-08-08 (somente alimentação).

## 4. Conflitos e alinhamentos

### Alinhamentos confirmados

- **Cálculo determinístico** — Diretriz (abertura e §15: "cálculos pelo sistema, não pela IA") ≡ INV-004 e F5 (Financial Engine). Sem divergência.
- **Isolamento entre usuários** — Diretriz §14 ≡ INV-008 + RLS defense-in-depth (F6 §11.9, P1#10).
- **IA sem invenção** — Diretriz §16 ("nunca inventar valores, preços, impostos, custos") ≡ regras de IA da Arquitetura §10 e Zod em tools (IA-001).
- **Erro não vira sucesso** — Diretriz §3 ("pedir confirmação quando houver dúvida") ≡ INV-013 e API-001.
- **Dados de demonstração separados** — Diretriz §17 ≡ estados explícitos e badges de completude (F13 §18.2/18.4).

### Conflitos e tensões

- **Multi-segmento × somente alimentação** — Diretriz (abertura e §17) prevê "outros segmentos"; a decisão de 2026-08-08 restringe ao setor de alimentação. Resolução registrada na §1 deste mapa; recomenda-se emenda na Diretriz.
- **MVP mínimo × programa F0–F15** — a Diretriz §17 pede MVP enxuto ("não adicionar funcionalidades desnecessárias"); o Plano é um programa de endurecimento de engenharia, não de escopo funcional. Não é conflito de produto, mas a comunicação de roadmap deve separar "funcionalidade nova" (congelada no MVP) de "correção/segurança/integridade" (P0 obrigatório).
- **Banco atual × alvo** — a Diretriz §14 descreve entidades sem amarrar provedor; o estado atual é Supabase e o alvo é PostgreSQL/Neon (F7–F8). Alinhado como direção; exige o mapeamento entidade-a-entidade citado na lacuna 7.

## 5. Recomendações (emendas sugeridas, não aplicadas)

- **R1 — Plano, F5 (§10)**: declarar as 11 funções da Diretriz §15 como contrato público do Financial Engine, com testes de propriedade por função (§10.7).
- **R2 — Plano, F5 (§10.1 Money)**: adicionar camada de formatação pt-BR (`R$ 1.234,56`, `10,00%`) separada da precisão interna.
- **R3 — Plano, F1 ou F5**: registrar a regra MEI/DAS (despesa fixa mensal, nunca variável por produto) e a proibição de presumir alíquotas como invariante de domínio tributário.
- **R4 — Plano, F6 (§11)**: incluir tabela de mapeamento das 12 entidades da Diretriz §14 para o schema-alvo, incluindo `OTHER_DIRECT_COSTS` e `MARKET_PRICES`.
- **R5 — Arquitetura, §6.6**: especificar as 7 regras de alerta do diagnóstico e o guia de linguagem hedged da Diretriz §13.
- **R6 — Plano, F13 (§18)**: adicionar a comparação visual de mercado da Diretriz §8 aos estados/badges de UX financeira.
- **R7 — Plano, §39 (itens deferidos) ou novo anexo de backlog**: registrar as expansões pós-MVP da Diretriz §17 (estoque, fluxo de caixa, DRE, ranking, WhatsApp, planos) como backlog futuro do setor de alimentação, explicitando que multi-segmento está fora de escopo.
- **R8 — Diretriz, abertura e §17**: emendar "outros segmentos/categorias de negócios" para refletir o foco exclusivo em alimentação decidido em 2026-08-08.

## 6. Reavaliação R1–R8 sob a Diretriz V7 (2026-08-09)

A V7 (`DIRETRIZ_PRECIFICA_PRECO_QUE_DA_LUCRO_V7_SHADCN_BASEUI_SINCRONIZADO_OFICIAL.md`) consolidou produto, arquitetura e engenharia em um único documento autenticado contra fontes oficiais. Status de cada recomendação:

| Rec. | Tema                               | Status sob a V7          | Evidência na V7                                                                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | Contrato das funções financeiras   | parcialmente atendida    | §8.5 documenta as fórmulas centrais conceituais; o contrato de API nomeado (11 funções) segue não declarado                                                                                                                                                                                                               |
| R2   | Formatação pt-BR                   | atendida                 | Seção "Formas financeiras especializadas" fixa exibição `R$ 1.234,56` separada da precisão interna                                                                                                                                                                                                                        |
| R3   | MEI/DAS e alíquotas                | atendida                 | Correções #15 (Tax Knowledge Boundary) e #16 (MEI); §10.1.1 "Fronteira de conhecimento tributário"                                                                                                                                                                                                                        |
| R4   | Mapeamento das entidades           | atendida com ressalva    | §13.1 lista 15 tabelas incluindo `other_direct_costs` e `market_price_history`; `taxes` e `financial_diagnostics` não têm tabela própria (tributação via §10.1.1; diagnóstico como saída computada) — confirmar intencionalidade                                                                                          |
| R5   | Alertas e linguagem do diagnóstico | atendida                 | §10.3 distingue fato/cálculo/simulação/estimativa/lacuna/interpretação; §10.4 reproduz a linguagem hedged ("vale investigar", "os dados indicam")                                                                                                                                                                         |
| R6   | Comparação de mercado              | atendida conceitualmente | Correção #17 ("mercado" como camada de contexto); §10.2 "Preço de mercado — referência externa informada"; §27.2. A visualização específica é detalhe de implementação                                                                                                                                                    |
| R7   | Backlog de expansões pós-MVP       | atendida                 | Seção "Novos requisitos incorporados ao backlog" e §28 "Itens deliberadamente adiados" (estoque, fluxo de caixa, DRE, WhatsApp, etc.)                                                                                                                                                                                     |
| R8   | Foco exclusivo em alimentação      | atendida                 | §2.2 define público-alvo inicial 100% alimentação (confeitaria, doces, restaurantes, lanchonetes, produção artesanal, cozinhas de produção, microempreendedores, comércio de alimentos); expansão multi-segmento persiste apenas como propriedade arquitetural ("sem reescrever o núcleo"), não como requisito de produto |

Pendência remanescente: **R1** — declarar as 11 funções financeiras como contrato público nomeado do Financial Engine (a V7 cobre as fórmulas conceituais, não a API nomeada).

## 7. Verificação de referências

Todas as seções citadas existem nos documentos-fonte: Diretriz §1–17; Plano §4 (macro-roadmap), §9–20 (fases F4–F15), §36–38 (P0/P1/P2), §39 (deferidos), §40 (ordem); Arquitetura §4, §6, §7–8, §9–11, §75–82. Classificações sem evidência direta foram marcadas como lacuna/parcial por ausência verificada, não por suposição.
