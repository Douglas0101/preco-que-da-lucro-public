# M-02 — reconciliação r5 do P3 (SDD v5.1-EXEC §7.3)

Data da leitura: 2026-08-27. Escopo exclusivo desta entrega: reconciliar as
contagens e contratos do inventário M-02 no checkout local. Este documento não
autoriza implementação, freeze, merge, publicação, migração, CI, Neon ou
produção.

## Classes de evidência

- **LOCAL-VERIFIED**: confirmado nesta rodada por leitura do checkout ou por
  check local que efetivamente executou.
- **REPORTED**: reproduzido de um artefato/documento histórico local, sem
  reexecução nesta rodada.
- **UNVERIFIED**: não há fonte atual suficiente, ou o comando pretendido não
  pôde executar.

O checkout observado foi `HEAD=477707dedee63ed23470e1effca6e4ed7aa90745`, em
detached HEAD com commit `wip(m02): preservar extracao para particao posterior`.
Há `.pi/` não rastreado, fora do write-set; ele não foi alterado. O SHA de
baseline citado em `baseline-2026-08-27.md` é histórico (`154efcd...`), não o
SHA corrente.

## 1. Contadores e delta contra RAT-1

Os números atribuídos a RAT-1 abaixo vêm do pedido de reconciliação; o artefato
RAT-1 não está presente no checkout pesquisado. Portanto, o lado RAT-1 e a
semântica da comparação são **REPORTED/UNVERIFIED**. O lado atual foi confirmado
na matriz compilada presente no checkout e pelo check equivalente local.

| Dimensão                            |          RAT-1 |             Atual | Delta aritmético | Evidência atual                                    |
| ----------------------------------- | -------------: | ----------------: | ---------------: | -------------------------------------------------- |
| módulos BFF (`*.functions.ts`)      |              6 |                 8 |               +2 | **LOCAL-VERIFIED**                                 |
| declarações `createServerFn`        |             26 |                30 |               +4 | **LOCAL-VERIFIED**                                 |
| usos/sites transacionais históricos |      “21 usos” | 13 sites literais |               -8 | atual **LOCAL-VERIFIED**; histórico **UNVERIFIED** |
| operações concretas/aliases         |             30 |                31 |               +1 | **LOCAL-VERIFIED**                                 |
| rotas API                           | não localizado |                 4 |                — | **LOCAL-VERIFIED**                                 |

O delta é apenas uma reconciliação numérica enquanto RAT-1 não for anexado. Em
particular, “21 usos” não pode ser tratado como sinônimo de
`directDatabaseFiles=21`: a matriz atual define o segundo como arquivos TypeScript
que importam ou alcançam persistência, enquanto `transactionSites` é a contagem
lexical de `context.transaction`/`request.transaction` classificada pelo gerador
(`docs/specs/M-02/spec.md:26-30`). O baseline também registra, historicamente,
42 ocorrências antes da extração e 13 depois (`docs/specs/M-02/baseline-2026-08-27.md:17-19`),
mas essa execução anterior é **REPORTED**, não um novo check.

### 1.1 Por que 6 → 8 módulos

O estado atual enumera exatamente estes oito módulos:

1. `src/lib/break-even.functions.ts`;
2. `src/lib/chat.functions.ts`;
3. `src/lib/dashboard.functions.ts`;
4. `src/lib/diagnostic.functions.ts`;
5. `src/lib/expenses.functions.ts`;
6. `src/lib/financial.functions.ts`;
7. `src/lib/price-formation.functions.ts`;
8. `src/lib/products.functions.ts`.

O `HEAD^` tinha os seis módulos já existentes e não tinha
`diagnostic.functions.ts` nem `price-formation.functions.ts`; os dois arquivos
foram adicionados no `HEAD` corrente. Isso explica localmente o aumento de
arquivos BFF em 6 → 8. A atribuição exata desse delta ao denominador específico
de RAT-1 continua **UNVERIFIED**, pois RAT-1 não foi encontrado.

### 1.2 Por que 26 → 30 `createServerFn`

O gerador não conta ocorrências textuais do nome importado: ele percorre
variáveis exportadas e classifica a inicialização como `createServerFn` ou
`alias` (`scripts/m02-matrix.ts:246-272`). A matriz atual declara 30
`createServerFn` (`matrix.yaml:8-14`). O diff local mostra duas novas entradas
de módulo (`getDiagnostic` e `calculatePriceFormationServer`) e a conversão
dos três child-delete legados para declarações diretas em
`products.functions.ts`; porém RAT-1 não está disponível para provar qual
dessas mudanças já estava incluída no seu denominador 26. Assim, o resultado
26 → 30 é **LOCAL-VERIFIED** como comparação solicitada, mas sua decomposição
histórica fina é **UNVERIFIED**.

### 1.3 Por que 31 operações versus 30 declarações

São dimensões deliberadamente distintas. A matriz atual contém 30 operações
classificadas como `declaration: "createServerFn"` e uma operação adicional
classificada como alias: `deleteProduct = archiveProduct`
(`matrix.yaml`, entrada de `src/lib/products.functions.ts`, próxima às linhas
do inventário de operações). Logo, 31 operações concretas/aliases não implica
31 declarações de servidor. O gerador soma separadamente as declarações e o
número total de operações (`scripts/m02-matrix.ts:312-326`). **LOCAL-VERIFIED**.

## 2. Os 13 sites literais

O gerador procura apenas o padrão lexical
`/\b(request|context)\.transaction\b/g` e classifica pelo caminho
(`scripts/m02-matrix.ts:246-272`). O inventário atual é:

| Site(s)                                                     | Quantidade | Classificação do gerador | Leitura de atomicidade                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ---------: | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/auth/membership.service.ts:16,31`               |          2 | `auth-allowlist`         | as duas instruções usam o mesmo `context.transaction` dentro da mudança de membership; a política de atomicidade específica de auth não está declarada na matriz (**UNVERIFIED** como boundary formal)                                                          |
| `src/server/repositories/ai-tool.repository.ts:22,40,64,84` |          4 | `repository-fallback`    | operações repository individuais no executor recebido pelo contexto; quando parte do replay de ferramenta, a unidade declarada é `per-tool-call` (**LOCAL-VERIFIED** na política; transação física por chamada não é provada só pelo site)                      |
| `src/server/repositories/ai-tool.repository.ts:106,116`     |          2 | `repository-fallback`    | os dois updates de `markSucceeded` usam o mesmo executor/contexto; pertencem ao fechamento de uma execução de ferramenta, mas o site lexical não prova commit independente (**LOCAL-VERIFIED** quanto ao agrupamento declarado; boundary físico **UNVERIFIED**) |
| `src/server/repositories/ai-tool.repository.ts:135,145`     |          2 | `repository-fallback`    | análogo para `markFailed`; unidade declarada `per-tool-call`/`per-tool-execution`, sem nova transação implícita provada pelo fallback (**LOCAL-VERIFIED** na política; boundary físico **UNVERIFIED**)                                                          |
| `src/server/repositories/conversation.repository.ts:86`     |          1 | `repository-fallback`    | fallback `executor ?? context.transaction`; não abre transação, herda o executor do caller (**LOCAL-VERIFIED**)                                                                                                                                                 |
| `src/server/repositories/executor.ts:10`                    |          1 | `repository-fallback`    | mesma regra de fallback centralizada; não abre transação (**LOCAL-VERIFIED**)                                                                                                                                                                                   |
| `src/server/services/conversation.service.ts:108`           |          1 | `compatibility-facade`   | participa da unidade `chat-reservation-history`, cujo boundary declarado é `tenant-transaction` (**LOCAL-VERIFIED**)                                                                                                                                            |
| **Total**                                                   |     **13** |                          |                                                                                                                                                                                                                                                                 |

Conclusão importante: 13 é contagem de ocorrências textuais, não contagem de
transações, commits ou unidades de trabalho. O overlay declara `sendChatMessage`
como `composed` com seis unidades: `chat-reservation-history` (`tenant-transaction`),
`model-round-reserve`, `model-round-settle`, `budget-sweep`,
`tool-execution-replay` (`per-tool-call`) e `audit-append`
(`per-tool-execution`) (`matrix.yaml`, política de transação de chat). A
matriz não fornece uma atomicidade independente para cada ocorrência lexical;
onde isso não está declarado, a classificação permanece **UNVERIFIED**.

## 3. As quatro rotas API

1. `GET/POST /api/auth/$` — `src/routes/api/auth/$.ts`; caminho de auth com
   persistência permitida pela allowlist.
2. `GET /api/health/live` — `src/routes/api/health/live.ts`; probe sem DB.
3. `GET /api/health/ready` — `src/routes/api/health/ready.ts`; probe PostgreSQL,
   exceção de infraestrutura.
4. `POST /api/vitals` — `src/routes/api/vitals.ts`; recebe e registra Web Vitals,
   sem DB.

Esses quatro caminhos são **LOCAL-VERIFIED** pela listagem da matriz e pelos
arquivos de rota. O validator conta `matrix.routes.length`; não os confunde com
as oito entradas BFF (`scripts/m02-boundaries.ts:92-103`).

## 4. M02-1a versus M02-1b

O checkout não contém rótulos explícitos `M02-1a`/`M02-1b`; esta separação é
registrada como interpretação operacional necessária para o §7.3:

- **M02-1a — reconciliação factual do inventário:** atual 8/30/31/4/13/21,
  lista dos sites, rotas e contratos acima. O conteúdo da matriz e o equivalente
  read-only passaram (**LOCAL-VERIFIED**); os comandos oficiais ficaram
  **UNVERIFIED** por falta de `tsx` local.
- **M02-1b — ratificação/congelamento executável:** **UNVERIFIED/PENDING**.
  `docs/specs/M-02/spec.md` continua `Status: DRAFT` e exige compilação
  determinística, entradas completas e RAT humano antes de `FROZEN`; Q-024
  também está marcado como decisão não aplicada. Logo M02-1a não aprova nem
  inicia M02-1b.

### Escolha normativa proposta para o DoD de Q-023

Para evitar que a distinção factual seja confundida com a conclusão do
freeze, o DoD de Q-023 deverá adotar a seguinte separação, ainda sem mudar o
status para `FROZEN`:

- **M02-1a é o invariante do freeze:** o inventário factual, a matriz, os
  contadores 8/30/31/4/13/21, a classificação dos sites, a allowlist e os
  contratos devem estar reconciliados e verificáveis no artefato congelado.
- **M02-1b é o objetivo de implementação do P10:** a mediação completa por
  services, a ausência de imports BFF → repository fora da política, os
  contratos por adição, os testes de paridade e os predicados M02-2..M02-6
  devem ser alcançados durante a extração pós-freeze.

Assim, M02-1a habilita a decisão humana de Q-023 sobre a spec/matriz; não
declara M02-1b concluído nem autoriza a extração M-02. A classificação
`UNVERIFIED/PENDING` acima permanece até a confirmação executável no checkout
principal e a aprovação humana correspondente.

### Escopo pós-S1 e validade dos checks M-02

Os arquivos `matrix.generated.yaml` e `matrix.yaml` continuam sendo os
artefatos do alvo de extração preservado em `wip/m02-extraction`
(`477707dedee63ed23470e1effca6e4ed7aa90745`). Eles não devem ser regenerados
contra a branch candidata pré-M-02: essa árvore ainda possui a implementação
legada, com contadores e alcance transacional diferentes do alvo documentado.

Por isso, no candidato limpo, `npm run m02:matrix:check` e
`npm run m02:boundaries` são **NOT-APPLICABLE/EXPECTED-FAILURE** até P10; a
execução contra a árvore limpa produziria drift e classificaria como ausentes
os paths que existem somente no WIP. A matriz 8/30/31/4/13/21 será
reverificada no próprio `wip/m02-extraction` antes da extração, e só então
promovida para evidência `LOCAL-VERIFIED` do candidato M-02.

Essa separação mantém a spec normativa sem mascarar a divergência entre o
estado legado atual e a arquitetura-alvo. Nenhum artefato derivado deve ser
alterado apenas para fazer o check passar na branch pré-M-02.

## 5. O validator aceita BFF → repository?

Sim, como regra estrutural explícita. `scripts/m02-boundaries.ts` considera um
caminho permitido quando ele está em uma exceção da matriz ou começa por
`src/server/repositories/` (`scripts/m02-boundaries.ts:62-71`). Portanto, uma
rota BFF que alcança um repository é aceita; uma alcançabilidade BFF para
`src/db/` fora da allowlist seria violação. O validator também exige política
de entrada, service/atomicidade por operação, catálogo existente, contagens
coerentes, sites classificados e as seis unidades de chat
(`scripts/m02-boundaries.ts:73-145`). A semântica foi confirmada por leitura e
por check equivalente local; a execução do binário oficial é **UNVERIFIED** por
`tsx: not found`.

## 6. DTOs decimais

Confirmado no contrato M-02 e no código local (**LOCAL-VERIFIED**):

- `DecimalString` é uma string branded nas fronteiras HTTP/DB, com `Decimal`
  no domínio (`src/lib/financial-values.ts:4-8`);
- dinheiro usa precisão 19 e escala 4;
- quantidades usam escala 6;
- percentuais são frações entre 0 e 1, escala 6;
- arredondamento monetário é `ROUND_HALF_UP`
  (`src/lib/financial-values.ts:106-114`);
- `contratos-dto.md` confirma strings monetárias com escala 4 e percentuais como
  frações (`docs/specs/M-02/contratos-dto.md:19-23`).

O código também rejeita decimais não finitos, aplica limites de precisão e
serializa resultados com escalas delimitadas (`src/lib/financial-values.ts:63-82,116-138`;
`src/server/services/financial.service.ts:143-164`). Isso confirma o contrato
de representação; não é uma alegação de que toda superfície externa já tenha
o mesmo grau de endurecimento.

## 7. `tokens_reserved=0` como leak-check

`tokens_reserved=0` deve ser interpretado como um **invariante de ausência de
reserva pendente ao final do cenário exercitado**, sempre lido junto com
`in_flight=0`; não é aprovação global do ledger nem prova de produção. No código,
reserva incrementa `tokens_reserved` e `in_flight` atomically no contador diário
(`src/server/repositories/budget.repository.ts:154-180`), enquanto settlement e
TTL sweep decrementam esses campos (`:64-113` e `:194-225`). O teste E6 ainda
asserta os dois valores em zero (`scripts/db/test-ai-budget.ts:479-487`).

Nesta rodada o E6 não foi reexecutado; a tabela em
`docs/evidence/e6-determinism-2026-08-27.md:40-61` é **REPORTED**. Assim, a
interpretação do zero como leak-check é **LOCAL-VERIFIED** pelo contrato e pelo
código, mas o resultado dinâmico continua **REPORTED**, não novo PASS. Também
permanece fora deste trabalho qualquer consumo de Q-023.

## 8. Checks e handoff

Checks read-only tentados:

```text
npm run m02:matrix:check  -> UNVERIFIED/BLOCKED: sh: 1: tsx: not found
npm run m02:boundaries    -> UNVERIFIED/BLOCKED: sh: 1: tsx: not found
```

Check equivalente, sem dependências externas e sem escrita, executado sobre os
artefatos atuais:

```text
node <script inline de comparação/contagem/allowlist> -> PASS
{"bffModules":8,"createServerFnDeclarations":30,"concreteOperations":31,
 "apiRoutes":4,"transactionSites":13,"directDatabaseFiles":21}
```

O artefato entregue por este writer é somente este arquivo. Não houve alteração
em código, `package.json`, `.pi/`, outras docs, GitHub, Neon, CI, nem push/fetch/
merge. O commit local e o digest SHA-256 serão informados no handoff final após
a verificação do write-set.
