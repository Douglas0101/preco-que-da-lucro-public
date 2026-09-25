# Runbook — SLO / error budget (§30)

Operação de `scripts/obs/error-budget.ts`: como apurar, como ler o artefato e o que fazer
quando uma classe estoura. A **política** (classes e tolerâncias candidatas) vive em
`docs/specs/M-06/error-budget.md`; aqui está o procedimento.

## 1. Para que serve

Responde uma pergunta só: **na janela medida, o consumo de erro de cada classe ficou dentro
da tolerância?** A ferramenta é local-first e parse-only — lê um JSONL local (ou stdin) e
grava um `.md` de evidência. Não consulta banco, não fala com o gateway de IA e não lê
nenhuma variável de ambiente.

O que ela **não** é:

- Não é o baseline M-06 (latência, pool, throughput). É a apuração de **erro** por código.
- Não é gate de CI nesta fase: nenhum workflow chama o script (promover a gate exige ADR).
- Não mede tráfego real sozinha: precisa que alguém exporte o JSONL (ver §4).

## 2. Estado: DRAFT — nada de `CONTROLADO` antes do baseline

M-06 está `PENDING`/`DRAFT` (`EXECUTION-STATE-PROGRAM.md`, linha do M-06) e o congelamento é
Q-020. Consequências operacionais, válidas hoje:

- O veredito da classe de IA é `DRAFT` enquanto `--baseline` não for declarado; a tolerância
  é **candidata**, não promessa.
- O artefato emitido nasce com a tarja `**DRAFT / NÃO-RATIFICADO**`. Nenhum caminho do script
  imprime `CONTROLADO` — esse rótulo pertence ao M-06 ratificado, não a esta ferramenta.
- `exit 2` é o resultado **esperado** nesta fase: sem baseline ratificado, a classe de IA sai
  `DRAFT` e o veredito geral vira `INDETERMINATE`. Um `exit 2` não é incidente; é a ferramenta
  dizendo "sem insumo ou sem baseline ratificado eu não declaro verde".
- Não use esta saída para bloquear PR, cortar deploy ou cobrar meta.

Só depois de Q-020 (baseline executado, tolerâncias recalculadas e carimbo no
`docs/specs/M-06/error-budget.md`) `--baseline=<ref>` passa a ter valor operacional.

## 3. Como rodar

```bash
# ajuda (imprime as opções e a semântica de exit)
npx tsx scripts/obs/error-budget.ts --help

# arquivo local
npx tsx scripts/obs/error-budget.ts --input=<logs.jsonl> --window=7d

# stdin (mesma apuração)
cat <logs.jsonl> | npx tsx scripts/obs/error-budget.ts --window=7d

# janela mais larga, piso de amostra menor, evidência em pasta datada
npx tsx scripts/obs/error-budget.ts --input=docs/evidence/<tema>-<data>/logs.jsonl \
  --window=24h --min-requests=100 --out=docs/evidence/<tema>-<data>/error-budget-24h.md

# depois do baseline ratificado (hoje a tolerância continua candidata)
npx tsx scripts/obs/error-budget.ts --input=<logs.jsonl> --baseline=<ref-do-baseline>
```

| Opção              | Default                                  | Efeito                                                                        |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `--input=<arq>`    | stdin                                    | JSONL de entrada. Ausente ⇒ lê stdin.                                         |
| `--window=<dur>`   | `7d`                                     | Janela relativa ao **último** `timestamp` do input; unidades `s`/`m`/`h`/`d`. |
| `--min-requests`   | `100`                                    | Piso de amostra (requests no envelope). Abaixo dele ⇒ `INSUFFICIENT`.         |
| `--baseline=<ref>` | ausente                                  | Ref do baseline M-06 que ratifica a tolerância de IA. Sem ele a IA é `DRAFT`. |
| `--out=<arq.md>`   | `docs/evidence/error-budget-<janela>.md` | Destino do artefato. Diretórios pais são criados se faltarem.                 |
| `--help`, `-h`     | —                                        | Imprime uso e sai com `0`.                                                    |

Argumento desconhecido, `--window` inválida (`7w`, `0d`, vazia) ou `--min-requests` não
inteiro positivo abortam com `exit 2` e mensagem no stderr — falha fechada, nunca verde.

## 4. Entrada aceita

JSONL: uma linha, um objeto JSON, campos `event` (string não vazia) e `timestamp`
(ISO-8601, parseado por `Date.parse`) obrigatórios. Linhas vazias são ignoradas; linha sem
JSON, sem `event` ou com `timestamp` inválido é descartada e **contada** no campo `ignoradas`
do artefato — descarte alto é sinal de export truncado, não de sucesso.

Campos reconhecidos: `code`, `status`, `correlationId`, `pathname`, `state`.

| Evento                 | Uso na apuração                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `request.completed`    | Envelope. `status ≥ 500` ⇒ `server_fault` (`HTTP_5XX`); `400–499` ⇒ excluído (`HTTP_4XX`); resto saudável.               |
| `request.failed`       | Envelope. Classifica por `code`; `code` ausente ⇒ `UNKNOWN_ERROR` em `server_fault` (fail-closed), nunca excluído.       |
| `app.financial.states` | `state=invalid` ⇒ financeiro crítico; `state=incomplete` ⇒ monitorado (não consome); outros ⇒ ok. Conta como sinal.      |
| `app.ai.timeouts`      | Métrica de timeout de IA; entra como piso de consumo de IA (`max` com as falhas de envelope).                            |
| `ai.*`                 | `ai.chat_completed`, `ai.model_attempt` etc. definem quais `correlationId` são requisições de chat (base da taxa de IA). |
| outros                 | Ignorados.                                                                                                               |

Classificação por `code` em `request.failed`:

- **consome** — `AI_TIMEOUT` e `DEPENDENCY_ERROR` (IA transitória); `DATABASE_ERROR`,
  `INTERNAL_ERROR` e qualquer outro código em `server_fault`.
- **não consome (excluído)** — `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`,
  `AUTHORIZATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT` e `AI_QUOTA` (429
  não-retryable): entrada inválida, falta de permissão, 404 de rota e quota atingida não
  medem disponibilidade do serviço (ADR-022 §2/§8).
- `DEPENDENCY_ERROR` só é IA quando o `correlationId` aparece em algum evento `ai.*` ou o
  `pathname` contém `chat`; fora disso é falha de servidor. Passe `correlationId` no export
  ou a classe infla — o artefato lista os códigos um a um para você conferir.

**Janela:** ancorada no último `timestamp` do input, não no relógio. Cobrir
`[âncora − janela, âncora]` torna a apuração determinística e re-executável sobre o mesmo
arquivo (ideal para evidência e para regressão de fixture). A ordem das linhas não importa;
eventos fora da janela **não** consomem budget.

**Origem do JSONL:** exporte do coletor/armazenamento de logs do ambiente (stdout do
processo, agregador, arquivo rotacionado) para um `.jsonl` local. A ferramenta não sabe
buscar log nem falar com a origem — se você não tem o arquivo, o passo anterior ainda não
foi feito.

## 5. Códigos de saída

Precedência de veredito: **`FAIL` > `INSUFFICIENT` > `INDETERMINATE` > `OK`**. Um budget
estourado vence o piso de amostra: com `N` baixo e uma classe exaurida o script ainda sai `1`
(erro observado é erro observado).

| Exit | Veredito        | Quando                                                                        | Leitura operacional                                                                                       |
| ---- | --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `0`  | `OK`            | Nenhuma classe exaurida, `N` ≥ piso, nenhuma classe `UNKNOWN`/`DRAFT`.        | Todas as classes medidas e dentro da tolerância.                                                          |
| `1`  | `FAIL`          | Alguma classe `EXHAUSTED`.                                                    | Budget estourado: siga §7 para a classe exaurida.                                                         |
| `2`  | `INSUFFICIENT`  | Nenhuma classe exaurida e `requests` na janela < `--min-requests`.            | Amostra pequena: **não** é verde. Alargue a janela ou junte mais tráfego — nunca baixe o piso para verde. |
| `2`  | `INDETERMINATE` | Nenhuma exaurida, `N` ok, mas alguma classe `UNKNOWN` (sem sinal) ou `DRAFT`. | Falta insumo (export da métrica) ou falta baseline ratificado. Corrija a entrada, não o veredito.         |

Erro de uso (argumento inválido, `--window` malformada) e exceção de I/O também saem `2` com
mensagem em stderr. Em qualquer execução real, `exit 2` significa "não sei, e não vou fingir
que sei".

Estados de classe que você vê no artefato:

- `OK` — medido e dentro da tolerância.
- `EXHAUSTED` — medido e acima da tolerância (zero estrutural, no caso de financeiro/servidor).
- `UNKNOWN` — classe **sem sinal** no input (ex.: nenhuma linha `app.financial.states`).
- `DRAFT` — IA transitória sem `--baseline`: tolerância candidata, não ratificada.

## 6. Como ler o artefato emitido

O `.md` tem tarja `DRAFT / NÃO-RATIFICADO`, cabeçalho (fonte, janela, linhas parseadas ×
ignoradas, requests na janela, baseline, veredito e exit) e as seções abaixo:

1. **Classes** — base, consumo, tolerância e veredito por classe. É a tabela que decide.
2. **Consumo por código** — quantas vezes cada código consumiu budget, por classe.
3. **Excluídos do budget** — o que apareceu e não consome (`VALIDATION_ERROR`, `AI_QUOTA`,
   `HTTP_4XX`…). Serve para provar que um 4xx não está inflando a leitura.
4. **Monitorados** — `FINANCIAL_STATE_INCOMPLETE` e `AI_TIMEOUT_METRIC`: informam, não consomem.
5. **Detalhe por classe** — a frase que explica cada veredito.
6. **Notas** — ressalvas da execução. Leia sempre: elas dizem explicitamente quando o
   resultado é fail-closed (sem sinal financeiro, sem baseline, N abaixo do piso).

Só o campo `Gerado em:` é volátil entre duas execuções do mesmo input — o resto é
re-derivável. Exportação de custo zero: o `.json` homônimo (mesmo relatório serializado)
existe para diff/consulta automatizada.

Versionamento da evidência: `docs/evidence/<tema>-<data>/` com o `.md` e o raw
(`.jsonl`/`.json`/`.txt`). **Nunca** `.log` nem `artifacts/`, `logs/`, `raw/`, que são
gitignored e não valem como fonte.

## 7. Quando o budget estoura — por classe

### Financeiro crítico (`app.financial.states{state=invalid}`) — tolerância zero

Trate como incidente de dados, não como ruído: `invalid` significa número corrompido ou
inconsistente no caminho do usuário, e nenhum volume de tráfego torna isso aceitável.

1. Extraia os `correlationId` dos eventos `invalid` da janela (o raw tem a linha; o `.md`
   só agrega) e correlacione com logs de request e spans.
2. Confira `app.financial.engine_version` e o último deploy/migration de cálculo.
3. Compare com `incomplete`: se o `invalid` apareceu onde antes havia `incomplete`, a
   suspeita é regressão de dado/seed, não de infraestrutura.
4. Se um deploy recente é candidato, reverta/restrinja antes de investigar a fundo.
5. Registre a evidência e o follow-up; zero não tem waiver, tem causa raiz.

### Falha de servidor/dependência (`DATABASE_ERROR`, `INTERNAL_ERROR`, 5xx) — zero até revisão no baseline

1. Separe por código (`Consumo por código`): `DATABASE_ERROR` ≠ `INTERNAL_ERROR` ≠ `HTTP_5XX`.
2. `DATABASE_ERROR`: confira `/api/health/ready`, saturação de pool, migration recente.
3. `INTERNAL_ERROR`: pegue o `correlationId` e siga o stack nos logs do serviço.
4. `HTTP_5XX`: localize a rota pelo `pathname` agregado nos spans.
5. A tolerância zero é candidata e será revisada no baseline M-06 (Q-020): se a revisão
   justificar valor maior, isso muda o documento de política, não a leitura desta execução.

### IA transitória (`AI_TIMEOUT` / `DEPENDENCY_ERROR` de chat) — só depois do baseline

Enquanto `--baseline` não for declarado, o veredito é `DRAFT` e **não existe burn de IA a
tratar**. Depois de Q-020, com `EXHAUSTED`:

1. Confirme a degradação graciosa (§31): sem IA o produto continua funcionando, chat é
   acessório — o erro não vira indisponibilidade.
2. Cheque provider/saúde da dependência e depois quota (`AI_QUOTA` fica fora do budget, mas
   explica muitos `AI_TIMEOUT`).
3. Olhe `app.ai.timeouts` e os eventos `ai.model_attempt` com `outcome=retry`: timeout que
   gera retry bem-sucedido não chega a `request.failed`.
4. Só então trate como consumo de budget — a taxa é sobre **requisições de chat**, não sobre
   o tráfego total.

### `UNKNOWN`, `INSUFFICIENT` e afins

- `UNKNOWN` financeiro = a série `app.financial.states` não foi exportada em JSONL (hoje ela
  é counter OTEL). Não é "sem erro": é **sem medição**. Exporte a série e rode de novo.
- `INSUFFICIENT` = amostra pequena. Alargue `--window` ou acumule tráfego. Reduzir
  `--min-requests` para obter verde é falsear o piso — se um piso diferente for legítimo,
  alinhe-o ao N do baseline no documento de política.
- `INDETERMINATE` = alguma classe `UNKNOWN`/`DRAFT`. A ação é sempre na entrada ou no
  processo (baseline), nunca no rótulo.

## 8. Garantia local-first / parse-only

O script:

- **lê** apenas `--input` (arquivo local) ou stdin;
- **escreve** apenas `--out` (mais o `mkdir` do diretório pai);
- não importa cliente de rede nem de banco (só `node:fs`, `node:fs/promises`, `node:path` e
  `prettier` para formatar o markdown);
- não lê `process.env`: `DATABASE_URL`/`NODE_ENV` não têm efeito nenhum;
- não tem opção de endpoint, host ou credencial — não existe caminho no CLI que aponte para
  produção, e nada é enviado a lugar algum.

Evidência reproduzível das provas (rede isolada, `strace` sem socket IP, escopo de escrita,
ambiente de produção inócuo): `docs/evidence/error-budget-2026-09-14/runs.txt`.

Regra prática: a coleta do log é um passo humano/tooling à parte; a ferramenta só apura o
arquivo que você entregar a ela.

## 9. Após Q-020 (o que muda)

1. Baseline M-06 executado e tolerâncias recalculadas em
   `docs/specs/M-06/error-budget.md` (que perde a tarja `DRAFT`).
2. As execuções passam a rodar com `--baseline=<ref>`; `INDETERMINATE` por `DRAFT` deixa de
   ser esperado.
3. Só então avalie promover a ferramenta a gate (exige ADR próprio) — e o gate, se existir,
   compara com tolerância ratificada, nunca com a candidata.

## Referências

- Política (classes e tolerâncias): `docs/specs/M-06/error-budget.md`
- Taxonomia de erros e retry: `docs/adr/ADR-022-error-taxonomy-observability.md`
- Degradação graciosa sem IA: Plano Mestre §31
- Evidência da apuração e das provas local-first:
  `docs/evidence/error-budget-2026-09-14/`
- Rótulos de estado (`DRAFT`, `NOT-EXECUTED`, `UNKNOWN`, `CONTROLLED`):
  `docs/specs/M-06/definition-of-done.md`
- Versionamento de evidência: `docs/runbooks/performance-evidence.md`
