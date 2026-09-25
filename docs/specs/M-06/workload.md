# M-06 — Workload controlado

**Status:** DRAFT
**Uso:** contrato de entrada para o runner de performance
**Congelamento:** Q-020
**Medições nesta revisão:** NOT-EXECUTED

## 1. Regras do workload

O workload deve ser criado antes do runner e não pode depender dos efeitos
colaterais de `scripts/db/explain-evidence.ts`. Esse script tem seed, cleanup,
rollback e escrita de evidence próprios; M-06 usará seed dedicado,
determinístico e reexecutável.

Cada execução deverá declarar:

- SHA completo e `git status --short --branch`;
- versão do Node, pacote do runner e versão do PostgreSQL;
- `DATABASE_DRIVER` e fingerprint não sensível do host do banco;
- perfil, cardinalidades produzidas e IDs da fixture;
- warm-up, duração, repetições e concorrência;
- cenário/variante e modo do provider de IA;
- contagem de erros, respostas e truncamentos;
- disponibilidade de `pg_stat_statements`, pool stats e `pg_stat_activity`.

Cada bucket de latência deverá preservar as observações brutas e declarar `N`.
O p99 será `N/A` quando houver menos de 100 observações válidas naquele bucket;
nenhum perfil será combinado para atingir esse limiar. O resumo calculará CV
entre os p50 das repetições: CV acima de 10% exige uma reexecução identificada
e preservação das execuções originais.

O dataset será criado em uma transação/fixture dedicada, com identificadores
determinísticos e limpeza limitada ao tenant do benchmark. O seed deverá ser
idempotente: executar duas vezes produz o mesmo estado lógico, sem apagar
dados fora da fixture.

## 2. Perfis S/M/L

| Perfil | Produtos | Filhos por produto | Despesas | Finalidade                            |
| ------ | -------: | -----------------: | -------: | ------------------------------------- |
| S      |        1 |                  4 |       30 | caminho mínimo e validação do harness |
| M      |      100 |                  4 |      500 | carga intermediária                   |
| L      |      500 |                  4 |    1.000 | comportamento próximo dos caps atuais |

Os quatro filhos por produto devem ser representados pelo conjunto mínimo de
entidades necessário ao read model atual. O manifesto do seed identificará os
tipos e quantidades reais, para que o resultado não dependa somente do rótulo
do perfil.

O perfil L deverá registrar explicitamente o efeito dos limites atuais:

- `products = 500`;
- `productChildren = 2.000` globalmente;
- `expenses = 1.000`;
- `simulations = 200`, quando o caminho testado alcançar simulações.

Se o caminho truncar dados por esses caps, o relatório deverá mostrar a
contagem solicitada, a contagem retornada e a indicação de truncamento. Não
alterar caps silenciosamente para melhorar a métrica.

## 3. Matriz de cenários

### 3.1 Dashboard

Operação: `getDashboardSummary`, associada à tela de dashboard `/inicio`.

Executar nos perfis S, M e L. Registrar:

- latência total;
- seis consultas esperadas no caminho atual, quando o código avaliado for o
  mesmo que o inventariado;
- duração e linhas retornadas por padrão de query;
- atividade do pool e `pg_stat_activity`;
- erro por requisição.

A contagem de seis queries é baseline observado, não uma meta universal. Se o
checkout mudar, o manifesto deverá indicar o SHA e a nova contagem.

### 3.2 Produtos com métricas

Operação: `listProductsWithMetrics`.

Executar nos perfis S, M e L, preservando os quatro filhos por produto e
observando a relação entre cardinalidade, caps e payload. O baseline atual
indica cinco consultas no read model; a execução deve confirmar ou atualizar
essa contagem no SHA medido.

Registrar especialmente:

- produtos solicitados e devolvidos;
- filhos solicitados e devolvidos por tipo;
- truncamento por limite;
- p50/p95/p99 por perfil;
- queries e rows em `pg_stat_statements`.

### 3.3 Diagnóstico

Operação: `getDiagnostic` para um produto determinístico de cada perfil.

O produto selecionado deverá possuir os quatro filhos e o conjunto de
despesas do perfil. Medir o caminho de leitura completo, sem executar
mutação, e separar tempo de banco de tempo de serialização. Se o detalhe não
possuir limite de filhos no SHA avaliado, registrar esse fato como parte do
baseline, não como falha silenciosa do seed.

### 3.4 Formação de preço

Operação: `calculatePriceFormationServer` com um payload válido e fixo,
contendo custos, impostos, taxas, alvo e preço de mercado conforme o schema
vigente.

Esse cenário deve ser executado separadamente de consultas de banco para
identificar o custo de cálculo/validação. A carga de produtos não altera o
payload; o cenário é uma referência de CPU e contrato, não uma simulação de
500 produtos.

### 3.5 Chat

Operação: `sendChatMessage` com provider mockado localmente. O mock deverá:

- não chamar gateway externo;
- retornar uso de tokens determinístico;
- permitir variante sem tool;
- permitir variante com uma tool determinística;
- permitir observar 1, 4 e 8 rounds;
- fixar histórico em 60 mensagens ou menos;
- registrar separadamente tempo de orquestração e tempo artificial do mock.

O provider-fixture é obrigatório para a carga: uma tentativa de chamada a
gateway externo invalida o run e deve aparecer como `INVALID-RUN`, nunca como
latência válida.

Executar nas concorrências 1, 2, 4 e 8. Não misturar o resultado desse
cenário com latência real de um provedor externo. `usageId`, settlement e
replay de tool pertencem aos testes de semântica/orçamento; o relatório de
performance deverá apenas indicar quando esses caminhos foram exercitados.

### 3.6 UI e vitals

Executar navegação controlada do dashboard e do fluxo de diagnóstico com
Playwright, usando fixture de autenticação e relógio/seed determinísticos.

Capturar:

- TTFB;
- LCP;
- CLS;
- FCP quando disponível;
- URL, perfil, navegador e viewport.

INP será sempre `RUM-ONLY`. O POST a `/api/vitals` poderá ter um smoke test de
contrato `204`, mas não será usado para produzir percentis de vitals.

### 3.7 E6 separado

E6 reproduzirá oito requests concorrentes com limite de dois slots. O relatório
deverá imprimir e verificar:

- `gatewayCalls <= 2`;
- `peakActiveCalls <= 2`;
- número de sucessos;
- número de rejeições de quota;
- relação entre requests, chamadas e rejeições.

E6 não será agregado aos p50/p95/p99 dos cenários de leitura. Falha de E6 será
reportada como falha de barreira concorrente, mesmo que todas as métricas de
latência estejam disponíveis.

Para a estabilidade do harness, repetir a matriz de 12 combinações abaixo sem
alterar o runtime de produção:

| `E6_HOLD_MS` | `E6_QUEUE_MS` |
| -----------: | ------------: |
|          300 |             0 |
|          300 |            50 |
|          300 |           200 |
|          300 |           500 |
|          600 |             0 |
|          600 |            50 |
|          600 |           200 |
|          600 |           500 |
|         1200 |             0 |
|         1200 |            50 |
|         1200 |           200 |
|         1200 |           500 |

Cada linha deve confirmar oito tentativas de reserva, dois admitidos, duas
chamadas/sucessos, seis rejeições `AI_QUOTA`, `gatewayCalls <= 2`,
`peakActiveCalls <= 2` e `tokens_reserved = in_flight = 0` ao final.

## 4. Protocolo de repetição

Para cada combinação cenário × perfil aplicável:

| Parâmetro     |                     Valor DRAFT |
| ------------- | ------------------------------: |
| Warm-up       |                            10 s |
| Janela medida |                            30 s |
| Repetições    |                               3 |
| Concorrência  |                     1, 2, 4 e 8 |
| Percentis     |                  p50, p95 e p99 |
| Provider      | mock local nos cenários de chat |
| Banco         |             PostgreSQL 17 local |
| Driver        |                 `node-postgres` |

Para cada repetição, o harness deverá executar `pg_stat_statements_reset()`
pela conexão administrativa antes da janela medida, registrar o timestamp e
preservar o snapshot bruto. A ausência da extensão ou da permissão será
`UNKNOWN`, não zero.

Uma repetição que termine com erro de infraestrutura não será incluída como
zero. Ela será marcada como `NOT-EXECUTED` ou `INVALID-RUN`, com causa e
artefato bruto preservados.

## 5. Query stats e pool

O ambiente local deverá iniciar PostgreSQL com
`shared_preload_libraries=pg_stat_statements`. O setup do harness criará a
extensão com `DATABASE_ADMIN_URL`, limpará/identificará a janela de coleta e
lerá os dados administrativos sem os expor ao processo de runtime.

Coletar por cenário:

- chamadas;
- tempo total e médio de execução;
- rows;
- padrões de query;
- sessões ativas/idle em `pg_stat_activity`;
- conexões ativas, idle e waiting do pool, se disponíveis;
- máximos observados e timestamp da amostra.

Ausência de uma dessas fontes será registrada como `UNKNOWN`, junto da razão.
Não derivar saturação a partir apenas da latência HTTP.

## 6. Cold activation

O runner poderá executar uma série local após restart do preview/app e outra
após restart do container Postgres, sempre com identificação explícita do
evento. Esses resultados serão chamados de **proxy local de cold start** e,
quando possível, serão decompostos em `compute-wake` e `first-query`.

Não haverá inferência de cold activation, autoscaling, scale-to-zero ou
latência Neon a partir dessa série. Qualquer medição Neon futura exigirá
workflow, ref e credenciais autorizadas e será publicada separadamente do
baseline local.

## 7. Artefatos obrigatórios

Cada execução deverá produzir:

1. JSON bruto por cenário e repetição;
2. manifesto do seed e cardinalidades;
3. resumo Markdown com p50/p95/p99;
4. tabela de erros e respostas;
5. snapshot de query stats;
6. snapshot de pool/atividade;
7. dados de vitals do Playwright;
8. metadados do SHA e do ambiente;
9. indicação de `CONTROLLED`, `NOT-EXECUTED` ou `UNKNOWN` por métrica.

O resumo não poderá apagar outliers, trocar falha por zero ou combinar perfis.
SLO/error budget será calculado somente depois que o baseline bruto estiver
disponível e será rotulado `CONTROLLED`.
