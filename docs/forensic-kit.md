# Kit Forense SDD v2

Contrato documental e runbook para validar relatórios `forensic_sdd_report` v2
em um fluxo híbrido, local e fail-closed.

## 1. Objetivo e limites

O kit separa o contrato executável, versionado no repositório, dos artefatos de
uma sessão forense, mantidos fora do checkout. O objetivo é permitir que cada
relatório seja validado estruturalmente, que as provas apontadas sejam
recalculadas a partir dos bytes reais e que a cadeia de checkpoints só avance
quando todas as invariantes forem satisfeitas.

Este documento define:

- o layout do kit e de `FORENSIC_EVIDENCE_DIR`;
- os comandos `report`, `evidence` e `chain`;
- os códigos de saída e os estados de aprovação/retenção;
- as regras de extração YAML, schema, evidência e continuidade da cadeia;
- o fluxo de staging, validação e rename atômico;
- a âncora imutável `GENESIS-*` e o manifesto determinístico;
- o fixture mínimo e a matriz de testes de regressão;
- os limites do orchestrator externo, que não está presente nesta rodada.

Esta é uma superfície local. O kit não consulta nem altera Neon/Postgres,
Browser, Linear ou Exa. A ausência de uma integração externa não é evidência de
aprovação: deve permanecer `OUT-OF-SCOPE`, `UNVERIFIED` ou `BLOCKED`, conforme
o caso.

O escopo desta rodada também não autoriza alteração em código, banco,
configuração, `AGENTS.md` global, Git publicado ou nos arquivos sujos
existentes. O único artefato documental deste write-set é este arquivo.

## 2. Layout híbrido

### 2.1 Superfície versionada

Os componentes executáveis ficam no repositório e são referenciados pelo
caminho absoluto no momento da execução:

```text
scripts/forensic/
├── forensic-report-v2.schema.json
├── forensic_validate.py
├── verify-forensic-session.sh
├── requirements.txt
└── fixtures/
    └── minimal-report.md
```

`forensic-report-v2.schema.json` é a fonte de verdade do contrato estrutural.
`forensic_validate.py` é o validador sem acesso de rede e com três subcomandos.
`verify-forensic-session.sh` é somente um wrapper determinístico para a
auditoria de evidências; ele resolve o Python a partir do script local e não
deve procurar um executável homônimo no `PATH`.

O schema não é copiado automaticamente para a área de evidências. A execução
recebe explicitamente o caminho do schema versionado, de modo que o digest do
contrato usado possa ser registrado no manifesto.

### 2.2 Área de evidências externa

`FORENSIC_EVIDENCE_DIR` aponta para uma área persistente, fora do checkout. Se
não for definido, o padrão documental é `$HOME/forensic-evidence`.

Antes de qualquer comando, o caminho deve ser absoluto, resolver para um
diretório existente e ser tratado como a raiz de confiança da sessão. Os
arquivos apontados pelas provas devem ser relativos a essa raiz. Não se deve
usar uma cópia do schema ou um diretório de evidências dentro do repositório
para simular a separação híbrida.

Layout esperado:

```text
$FORENSIC_EVIDENCE_DIR/
├── GENESIS-YYYY-MM-DD/
│   └── FINAL-REPORT.md                 # seed legado, identificável e hasheável
├── CHK-YYYY-MM-DD-HHMM/
│   ├── FINAL-REPORT.md                 # um documento YAML v2 por checkpoint
│   └── ...                              # provas referenciadas, se aplicável
├── PROOF-A-*/                           # artefatos fora do diretório da sessão,
├── PROOF-B-*/                           # quando o índice assim os referenciar
└── chain-manifest.json                  # escrito somente após CHAIN_PASS
```

O nome de cada diretório de checkpoint é também o `session_id` esperado no
relatório. O nome deve seguir:

```text
GENESIS-YYYY-MM-DD
CHK-YYYY-MM-DD-HHMM
```

Cada `CHK-*` precisa conter exatamente o arquivo `FINAL-REPORT.md` que será
validado. Diretórios estranhos à cadeia podem existir na raiz, mas não entram
na ordenação; um item que começa com `GENESIS-` ou `CHK-` e não é um diretório
real, não possui relatório ou usa um nome inválido causa falha da cadeia.

## 3. Contrato dos relatórios

### 3.1 Extração segura

O relatório é Markdown com documentos YAML cercados por bloco `yaml` ou `yml`.
Os documentos lógicos permitidos são:

- `forensic_sdd_report` — obrigatório;
- `ledger_record` — no máximo uma instância;
- `proof_validation_report` — no máximo uma instância.

O extrator deve rejeitar:

- ausência de `forensic_sdd_report`;
- chave YAML duplicada no mesmo mapa;
- mais de um bloco para o mesmo documento lógico;
- sobrescrita silenciosa por `dict.update` ou fusão equivalente;
- documento YAML que não seja um mapa;
- campos desconhecidos quando o schema os fecha com `additionalProperties: false`.

Um relatório textual não transforma uma afirmação narrativa em evidência. A
validação usa apenas os valores estruturados e os bytes dos arquivos apontados.

### 3.2 Regras estruturais e semânticas

O schema v2 e as verificações semânticas devem manter, no mínimo, estas
invariantes:

- todos os objetos que representam contrato são fechados;
- `version` é `2` e `mode` é `INVESTIGATIVE_FORENSIC`;
- `session_id` possui um formato permitido, data calendariamente válida e,
  quando aplicável, horário entre `00:00` e `23:59`;
- `date` é uma data calendariamente válida e coincide com a data do
  `session_id`;
- datetimes são RFC 3339 com timezone explícito;
- `subagents` contém exatamente uma ocorrência de cada ID permitido:
  `F1-DOC-GIT`, `F2-M02-DATA`, `F3-SEC-PLATFORM` e `F4-TEST-SYNTH`;
- `WAITING_ON_ENVIRONMENT` exige owner de infraestrutura e SLA válido;
- `ESCALATION_INCIDENT` exige `escalation.active: true`, severidade, owner e
  motivo;
- `proof_a` aprovado exige A1, A2 e A3 aprovados;
- `proof_b` aprovado exige os sete checks verdadeiros;
- um veredicto `PASS` ou `READY_FOR_VERDICT` não pode coexistir com Prova A ou
  B pendente, rejeitada ou falha;
- `ADVANCE_RECOMMENDED` exige Provas A e B aprovadas;
- `gates_consumed` não vazio exige `gates_authorization` correspondente;
- drift `UNEXPECTED` ou `MIXED` exige `action_taken`;
- snapshot executado exige destino verificável, arquivo regular e
  `archive_sha256` recalculável;
- `final_state` espelha semanticamente `session_state`, `product_verdict`,
  `m02`, `gates_consumed` e `release_or_p8`;
- `ledger_record`, quando presente, coincide com `session_id`, `head_observed`,
  veredicto, gates, branch/repositório e decisão de release do relatório;
- `proof_validation_report`, quando presente, coincide com as provas e a
  decisão do relatório;
- `proof_validation_report` é obrigatório em `PROOF_VALIDATION` e quando a
  recomendação for `ADVANCE_RECOMMENDED`.

O relatório deve permanecer `NO-VERDICT`/`DO_NOT_ADVANCE` enquanto uma prova,
autorização, dependência ou recomputação obrigatória estiver ausente.

## 4. CLI e códigos de saída

Defina os caminhos sem depender do diretório corrente. Exemplo de preparação
para a execução:

```bash
REPO_ROOT="/home/douglas-souza/preco-que-d-main"
SCHEMA_PATH="$REPO_ROOT/scripts/forensic/forensic-report-v2.schema.json"
VALIDATOR_PATH="$REPO_ROOT/scripts/forensic/forensic_validate.py"
WRAPPER_PATH="$REPO_ROOT/scripts/forensic/verify-forensic-session.sh"
EVIDENCE_ROOT="${FORENSIC_EVIDENCE_DIR:-$HOME/forensic-evidence}"
```

`EVIDENCE_ROOT` deve ser convertido/validado como caminho absoluto antes de
ser usado. Os comandos públicos são os seguintes.

### 4.1 Validação estrutural (`report`)

```bash
python3 "$VALIDATOR_PATH" report \
  "$SCHEMA_PATH" \
  "$SESSION_DIR/FINAL-REPORT.md"
```

Essa barreira carrega o schema, extrai o YAML com loader que rejeita chaves
duplicadas, aplica JSON Schema e executa as invariantes semânticas. Ela não
escreve o manifesto e não promove o relatório para a cadeia.

### 4.2 Auditoria de evidências (`evidence`)

Forma direta:

```bash
python3 "$VALIDATOR_PATH" evidence \
  "$SESSION_DIR" \
  --evidence-root "$EVIDENCE_ROOT"
```

Forma recomendada pelo wrapper:

```bash
"$WRAPPER_PATH" "$SESSION_DIR" \
  --evidence-root "$EVIDENCE_ROOT"
```

Para cada item de `proof_a.evidence_index`, a auditoria exige caminho relativo,
arquivo regular, ausência de `..`, ausência de symlink em qualquer componente,
existência dentro da raiz e igualdade byte a byte do SHA-256 declarado. O
mesmo vale para o arquivo de snapshot quando `preservation.snapshot.performed`
for `true`.

Se `expected_scope.computed` for `true`, a auditoria deve recomputar, no
repositório indicado pelo próprio relatório, a lista canônica de
`git diff --name-only --no-renames <base> <head>`, ordená-la, contar os caminhos
e hashear a representação com uma linha final por caminho. Repositório
inacessível, SHA inválido, divergência de contagem ou digest divergente é
`UNVERIFIED`/falha de auditoria e não pode sustentar `PASS`.

### 4.3 Validação da cadeia (`chain`)

Forma básica, com o manifesto sendo escrito somente após sucesso:

```bash
python3 "$VALIDATOR_PATH" chain \
  "$EVIDENCE_ROOT" \
  "$SCHEMA_PATH"
```

Forma de pré-validação de um candidato em staging:

```bash
python3 "$VALIDATOR_PATH" chain \
  "$EVIDENCE_ROOT" \
  "$SCHEMA_PATH" \
  --candidate "$STAGING_SESSION_DIR" \
  --genesis-sha256 "$GENESIS_REPORT_SHA256"
```

Quando a variável de ambiente for preferível a uma opção explícita, a âncora
pode ser fornecida por `FORENSIC_GENESIS_SHA256`. A opção explícita tem
precedência e sempre deve conter exatamente 64 caracteres hexadecimais
minúsculos.

Os códigos de saída são estáveis:

| Código | Significado                                                      | Ação do caller                                                               |
| -----: | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
|    `0` | validação aprovada (`SCHEMA_PASS`, `AUDIT_PASS` ou `CHAIN_PASS`) | pode seguir a próxima barreira                                               |
|    `1` | violação de schema, evidência, política ou cadeia                | reter staging/manifesto e corrigir ou registrar bloqueio                     |
|    `2` | erro de extração, dependência, parsing ou ambiente               | não classificar como falha de produto nem como aprovação; reparar o ambiente |

Saídas `SCHEMA_FAIL`, `AUDIT_FAIL` e `CHAIN_FAIL` são negativas. Saídas
`EXTRACTION_FAIL` e `ENVIRONMENT_FAIL` indicam que a validação não conseguiu
produzir um resultado confiável. Em nenhum caso o caller deve converter um
erro em `PASS` por fallback.

## 5. Integridade da cadeia e âncora GENESIS

### 5.1 Ordenação e continuidade

A ordem é semântica, nunca a comparação textual simples de nomes:

1. deve existir exatamente um diretório `GENESIS-*` configurado;
2. `GENESIS-*` é a primeira entrada;
3. os `CHK-*` são ordenados por data e horário extraídos do identificador;
4. cada sessão possui `FINAL-REPORT.md` e `session_id` igual ao nome do
   diretório;
5. o primeiro checkpoint aponta para o digest do `GENESIS` conforme a âncora
   definida pelo processo;
6. cada checkpoint seguinte aponta para o `id` e o SHA do relatório
   imediatamente anterior;
7. uma sessão inválida intermediária não pode ser pulada para validar uma
   sessão posterior;
8. mudança de `repository.head_observed` só é aceita se o novo relatório
   contiver um item com `artifact: git/HEAD` e `authorized: true`;
9. duas sessões consecutivas em `WAITING_ON_ENVIRONMENT` preservam exatamente
   o mesmo `governance.sla.waiting_since`.

O SHA encadeado é o digest do arquivo `FINAL-REPORT.md`, não o digest do
diretório. Para obter a âncora de um seed:

```bash
sha256sum "$EVIDENCE_ROOT/GENESIS-YYYY-MM-DD/FINAL-REPORT.md"
```

O seed `GENESIS-*` pode ser legado e não precisa cumprir o schema v2, mas deve
ser identificável, legível e hasheável. Seu digest deve ser fornecido por
`--genesis-sha256` ou por uma âncora externa preservada. O validador não deve
substituir automaticamente essa âncora.

### 5.2 Manifesto determinístico

`chain-manifest.json` é a saída de uma cadeia aprovada e inclui, no mínimo:

- versão do manifesto;
- versão do validador;
- SHA-256 do schema usado;
- estado e digest da âncora `GENESIS`;
- lista ordenada de sessões, digest, schema que admitiu a sessão, estado,
  veredicto, M-02, HEAD e SLA;
- indicador de validade por sessão.

O manifesto não deve conter um `checked_at` variável no conteúdo canônico.
Sua escrita deve ocorrer em arquivo temporário no mesmo diretório, com flush e
`fsync`, seguida de rename com `os.replace` e, quando disponível, `fsync` do
diretório. Se qualquer sessão falhar, o manifesto aceito anterior permanece
intacto; nenhum manifesto parcial substitui a última cadeia válida.

### 5.3 Provenança do schema por sessão

Além do `schema_sha256` global do manifesto, cada entrada de sessão registra o
SHA-256 do schema que a admitiu. O critério de admissão é congelado no momento
da admissão, nunca retroativo:

1. se `schema_sha256` divergir entre duas entradas consecutivas, a cadeia deve
   ser integralmente revalidada antes de qualquer nova admissão;
2. sessões admitidas sob um schema anterior preservam a validade histórica sob
   o hash registrado na própria entrada;
3. alterar o schema versionado exige artefato de autorização de drift citável,
   como qualquer outra manipulação de evidência (NIST SP 800-86).

## 6. Staging, três barreiras e rename atômico

O orchestrator que possuir uma nova sessão deve seguir esta sequência:

1. identificar o checkpoint anterior e capturar seu `id` e SHA;
2. criar uma sessão em diretório de staging que não seja descoberto como
   `CHK-*` na raiz da cadeia;
3. gerar `FINAL-REPORT.md` com o schema v2, o `previous_session` correto e
   referências relativas às provas;
4. executar `report` e exigir código `0`;
5. executar `evidence`/`verify-forensic-session.sh` e exigir código `0`;
6. executar `chain --candidate` e exigir `CHAIN_PASS`/código `0`;
7. somente depois das três barreiras, renomear o staging para seu nome final
   `CHK-YYYY-MM-DD-HHMM` no mesmo filesystem;
8. executar `chain` sem `--candidate` para validar a cadeia materializada e
   gerar o manifesto por rename atômico;
9. se qualquer etapa falhar, manter o staging para diagnóstico, não criar uma
   entrada `CHK-*` e não substituir o manifesto aceito.

O rename final deve ser atômico e não pode atravessar filesystems. O caller
deve verificar que o destino final não existe e que o nome final corresponde ao
`session_id`; colisão de nome é falha, não convite para sobrescrever uma sessão
existente.

### Compatibilidade do staging

O validador aceita um candidato cujo basename ainda não começa com `CHK-`,
desde que ele seja um diretório real, não seja um symlink, esteja dentro da
raiz de evidências e contenha um relatório cujo `session_id` seja o nome final
válido. Assim, o candidato permanece fora da descoberta normal até o rename.
Depois da materialização, a sessão é novamente validada sem `--candidate` e o
manifesto só é substituído após essa cadeia aprovada.

## 7. Política fail-closed

As regras seguintes são obrigatórias para o caller e para qualquer futuro
orchestrator:

- ausência de relatório, prova, hash, autorização ou dependência não equivale a
  `PASS`;
- falha de parsing ou ambiente não equivale a `FAIL` de produto, mas bloqueia
  promoção e fica em `BLOCKED`/`UNVERIFIED`;
- caminhos absolutos, traversal, symlinks, arquivos ausentes e hashes
  divergentes produzem `AUDIT_FAIL`;
- um campo desconhecido, chave duplicada ou documento YAML duplicado produz
  falha de extração/schema;
- `PASS`, `READY_FOR_VERDICT` e `ADVANCE_RECOMMENDED` exigem provas e
  autorizações compatíveis;
- nenhum relatório inválido é pulado durante a cadeia;
- nenhuma falha permite substituir `chain-manifest.json`;
- nenhuma aprovação é inferida a partir de `findingCount=0`, arquivo vazio,
  comentário parcial, ausência de handoff ou texto narrativo;
- nenhum comando do kit faz consulta de rede, mutação Git, operação remota,
  alteração de banco ou publicação de issue/comentário.

O estado produzido deve distinguir, quando aplicável, `LOCAL-VERIFIED`,
`REPORTED`, `UNVERIFIED`, `BLOCKED`, `OUT-OF-SCOPE` e `UNKNOWN`. Um resultado
local do kit não é aprovação de CI, Neon, Browser, release ou produção.

## 8. Fixture e matriz de testes

O fixture estrutural mínimo está em
[`scripts/forensic/fixtures/minimal-report.md`](../scripts/forensic/fixtures/minimal-report.md).
Ele exercita o contrato com `WAITING_ON_ENVIRONMENT`, não declara snapshot
executado e não deve ser tratado como prova real de Git, Neon, CI ou produto.
Os commits e o digest vazio presentes no fixture são valores sintaticamente
válidos para teste estrutural; testes de escopo devem usar um repositório
temporário e SHAs reais.

Quando a suíte estiver disponível, a preparação deve usar ambiente isolado e
as versões fixadas em
[`scripts/forensic/requirements.txt`](../scripts/forensic/requirements.txt),
sem `pip install --user`:

```bash
python3 -m venv .venv-forensic
. .venv-forensic/bin/activate
python -m pip install -r scripts/forensic/requirements.txt
python3 -m unittest discover
```

O conjunto mínimo de regressão deve cobrir:

### Schema e extração

- fixture mínimo válido;
- `PASS` com Provas A/B pendentes;
- Prova A ou B aprovada com subprova/check falso;
- prova rejeitada sem `rejection_reason`;
- gate consumido sem autorização;
- espera sem owner/SLA;
- incidente sem objeto `escalation` ativo;
- snapshot executado sem destino/hash verificável;
- data inválida, datetime sem timezone e `session_id` inconsistente;
- campo desconhecido em cada objeto fechado;
- IDs de subagents duplicados ou conjunto incompleto;
- divergência entre relatório, `final_state`, `ledger_record` e
  `proof_validation_report`;
- bloco YAML duplicado e chave YAML duplicada.

### Evidências e escopo

- caminho com traversal, caminho absoluto, symlink, arquivo ausente e arquivo
  não regular;
- hash incorreto e hash correto recalculado a partir do arquivo;
- snapshot apontando para diretório, symlink ou arquivo com digest incorreto;
- `expected_scope.computed` com lista, contagem e digest corretos;
- repositório inacessível, SHA inválido e divergência de escopo classificados
  como não verificáveis/falha, nunca como aprovação.

### Cadeia e promoção

- ordem explícita `GENESIS → CHK`, inclusive o caso que falha por ordenar
  lexicograficamente `CHK` antes de `GENESIS`;
- mais de um `GENESIS-*`, seed ausente ou primeiro checkpoint sem âncora;
- digest/ID de `previous_session` incorreto;
- sessão inválida intermediária que não pode ser pulada;
- HEAD alterado sem drift autorizado e com `git/HEAD` autorizado;
- reset indevido de `waiting_since`;
- manifesto anterior preservado quando a cadeia falha;
- candidato de staging não incorporado à cadeia antes das três barreiras;
- rename atômico, colisão de destino e rerun idempotente após aprovação;
- digest do schema e versão do validador registrados no manifesto.

Os critérios de aceite do kit são: os testes da suíte passam; os três comandos
retornam os códigos definidos; nenhum campo desconhecido ou duplicação YAML é
aceito; nenhum arquivo entra em `CHK-*` antes das barreiras; e uma falha deixa
o manifesto aceito e o staging anterior preservados.

## 9. Orchestrator externo e integrações fora do escopo

Não existe, no estado local observado, um `forensic-session.sh` ou
`verify-forensic-session.sh` externo em `~/forensic-evidence` que possa ser
patchado como se fosse a implementação do orchestrator. O wrapper versionado
em `scripts/forensic/verify-forensic-session.sh` é uma superfície local
conhecida; não se deve inferir fases, prompts, paths, gates ou comandos de um
orchestrator ausente.

Um futuro orchestrator só pode ser conectado depois que seu caminho e conteúdo
forem fornecidos ou sua criação for autorizada. Ele deverá chamar as três
barreiras, preservar staging em falha, executar o rename atômico apenas após
aprovação e deixar a decisão de gate/release explícita e humana.

Nesta rodada não foram nem serão usados:

- Neon/Postgres real ou migração/cutover;
- Browser in-app, login, snapshot de UI ou fallback de navegador;
- Linear, criação/edição de issue, comentário ou atualização externa;
- Exa, pesquisa ou validação de fontes externas.

Também não fazem parte deste contrato uma autorização de merge, publicação,
deploy, release, consumo de gate ou limpeza do checkout. O kit documenta e
valida evidência local; ele não amplia a autoridade do processo.

## 10. Addendum 2026-09-06 — bundle operacional de passo (Fase 0.4 / A4)

O contrato v2 (seções 1–9) valida relatórios forenses formais. O **bundle
operacional de passo** é a captura bruta e mínima exigida pelo protocolo de
cutover A4 em qualquer FAIL/abort, antes de qualquer retry. Ele não substitui
um `forensic_sdd_report`; quando a rodada exigir relatório formal, o bundle é
insumo e as provas relevantes devem ser materializadas em
`FORENSIC_EVIDENCE_DIR` conforme as seções 2–7.

Conteúdo mínimo, gerado por
`npm run m02:forensic-bundle -- --out <dir> --note "<contexto do passo>"`
(`--include <arquivo>` repete para cada saída de sonda):

- versões: Node, npm, git, SO (`uname`), e branch/HEAD/estado curto do
  repositório;
- saídas das sondas envolvidas, copiadas com SHA-256 registrado em
  `SHA256SUMS`;
- diff de ambiente seguro: apenas **NOMES** de variáveis relevantes (prefixos
  `DATABASE|BETTER_AUTH|AUTH_|AI_|RESEND|OTEL|NODE|PORT|HOST`), nunca valores;
- timestamps UTC de início/fim da captura;
- contexto: nota textual do passo (homologação/smoke/pós-op) e status
  declarado (PASS/FAIL/ABORT).

Regras herdados: fail-closed (códigos `0` sucesso e `2` erro de ambiente, na
semântica da seção 4; nenhum bundle é emitido por fallback); nenhuma consulta
de rede ou mutação; nenhum valor de segredo é emitido — o caller só informa
arquivos já redigidos.
