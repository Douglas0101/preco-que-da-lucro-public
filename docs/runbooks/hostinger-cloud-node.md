# Runbook — Node/Nitro no Hostinger Cloud Startup

Este runbook descreve somente a camada de aplicação Node/Nitro. Ele não transforma a Hostinger em provedor PostgreSQL e não substitui a validação externa do hPanel.

## Contrato de build e start

Pré-requisitos:

- Node.js `24.15.0` ou superior;
- npm conforme o `packageManager` do projeto;
- processo persistente com reinício automático;
- saída HTTPS para PostgreSQL externo, Resend e gateway de IA.

Na raiz do projeto:

```text
npm ci
npm run build
npm run start
```

O comando de produção é:

```text
node .output/server/index.mjs
```

`.output/server/index.mjs` é artefato gerado. Não editar esse arquivo manualmente e não iniciar o processo de produção antes de um build correspondente ao commit publicado.

`npm run preview` permanece destinado a preview local. O processo persistente do hPanel deve usar `npm run start` ou o comando Node equivalente acima.

## Porta e host

O runtime Nitro gerado aceita as variáveis convencionais do servidor:

```text
NITRO_PORT → PORT
NITRO_HOST → HOST
```

Quando ambas as variáveis de porta existirem, `NITRO_PORT` prevalece. A validação local usa um valor de `PORT` deliberadamente inválido para comprovar essa precedência. Se a plataforma fornecer somente `PORT`, ele continua sendo aceito.

Confirmar no hPanel:

- qual variável a plataforma injeta;
- se o valor é repassado ao processo Node;
- em qual host o processo deve fazer bind;
- se o proxy HTTPS encaminha para essa porta;
- se o processo é reiniciado após falha.

## Health checks

Usar os endpoints sem autenticação:

```text
GET /api/health/live
GET /api/health/ready
```

Comportamento esperado:

- `/api/health/live` retorna HTTP 200 quando o processo está vivo e não depende do PostgreSQL;
- `/api/health/ready` retorna HTTP 200 quando `select 1` no PostgreSQL funciona;
- `/api/health/ready` retorna HTTP 503 quando o PostgreSQL está indisponível;
- falhas de readiness registram `health.readiness_failed` nos logs estruturados.

O smoke local degradado é:

```text
npm run build
npm run check:hostinger-runtime
```

Esse smoke não executa migrations, não escreve no Neon e não usa Resend, Google OAuth ou gateway de IA.

O E2E que depende de fixture Better Auth/PostgreSQL deve ser iniciado pelo
wrapper de higiene:

```text
npm run test:e2e:hygiene
```

O wrapper exige `DATABASE_URL`, `DATABASE_ADMIN_URL`, `E2E_AUTH_EMAIL` e
`E2E_AUTH_PASSWORD`, além das dependências instaladas. Ele falha antes de
iniciar o Playwright quando a preparação/configuração está ausente e remove
`NO_COLOR` do ambiente antes de executar `npm run test:e2e`. A preparação da
fixture executa migrations e escreve no banco configurado; portanto, use um
banco de teste autorizado e nunca uma URL de produção.

No smoke local degradado do runtime, é esperado observar
`GET /api/health/live → 200` e `GET /api/health/ready → 503` quando o
PostgreSQL deliberadamente indisponível é usado pelo teste. Esse `ready=503`
é evidência de que a aplicação sinaliza a dependência indisponível; não é
prova de falha da aplicação e não constitui readiness de produção. Readiness
de produção exige validação separada com o PostgreSQL de produção e os
controles operacionais do hPanel.

Para validar readiness saudável, executar a aplicação com PostgreSQL local já migrado:

```text
DATABASE_DRIVER=node-postgres \
DATABASE_URL=<URL local de runtime> \
BETTER_AUTH_URL=http://127.0.0.1:4173 \
AUTH_TRUSTED_ORIGINS=http://127.0.0.1:4173 \
PORT=4173 \
npm run start
```

Então verificar:

```text
GET /api/health/live  → 200
GET /api/health/ready → 200
```

## Variáveis por processo

### Web/runtime na Hostinger

Obrigatórias ou operacionais:

```text
DATABASE_URL
DATABASE_DRIVER
BETTER_AUTH_URL
BETTER_AUTH_SECRET
AUTH_TRUSTED_ORIGINS
```

`BETTER_AUTH_URL` deve ser a origem HTTPS pública, sem path, query, credencial ou fragmento. `BETTER_AUTH_SECRET` deve ter pelo menos 32 caracteres.

O processo web não deve receber `DATABASE_ADMIN_URL`, `SUPABASE_MIGRATION_DATABASE_URL`, `MIGRATION_APPLY`, `MIGRATION_ALLOW_UPSERT` ou `MIGRATION_REPORT_PATH`.

### E-mail transacional

O código usa Resend, não o e-mail genérico do hPanel:

```text
RESEND_API_KEY
AUTH_EMAIL_FROM
```

Confirmar domínio remetente, DNS e saída HTTPS no Resend. A ausência dessas variáveis impede os fluxos de verificação e recuperação de senha.

### Gateway de IA

O chat depende de serviço externo compatível com o contrato Chat Completions:

```text
AI_GATEWAY_URL
AI_GATEWAY_API_KEY
AI_MODEL
AI_REQUEST_TIMEOUT_MS
AI_MODEL_TIMEOUT_MS
AI_MODEL_MAX_ATTEMPTS
AI_MAX_TOOL_ROUNDS
AI_CHAT_LIMIT_PER_10_MINUTES
AI_DAILY_CHAT_LIMIT_PER_TENANT
```

O timeout efetivo do proxy e da plataforma para o chat ainda precisa ser confirmado no hPanel; validar valor superior a 60 segundos, além do timeout do gateway. A Hostinger não substitui o gateway de IA.

### Observabilidade e segurança

Opcionais:

```text
OTEL_SERVICE_NAME
OTEL_EXPORTER_OTLP_ENDPOINT
CSP_ENFORCE
```

Logs stdout/stderr devem ser consultáveis e não podem conter secrets, URLs de conexão, tokens ou passwords. `CSP_ENFORCE=false` não deve ser interpretado como CSP efetiva em produção.

### Migration/admin

Executar migrations somente em processo controlado, via CI ou SSH autorizado:

```text
DATABASE_ADMIN_URL
EXPECTED_POSTGRES_MAJOR=17
MIGRATION_APPLY
MIGRATION_ALLOW_UPSERT
MIGRATION_REPORT_PATH
```

`DATABASE_ADMIN_URL` é a conexão direct/admin e nunca deve ser exposta ao runtime web. O processo de migration deve iniciar na raiz do repositório para resolver a pasta `drizzle` corretamente.

`SUPABASE_MIGRATION_DATABASE_URL` só existe no fluxo opcional de origem legada, em modo read-only controlado. Ela nunca entra no processo web.

## PostgreSQL e Neon

O contrato recomendado permanece:

```text
Hostinger Cloud Startup
└─ Node/Nitro/SSR/BFF
   └─ DATABASE_URL pooled → PostgreSQL externo, preferencialmente Neon

CI/SSH controlado
└─ DATABASE_ADMIN_URL direct → migrations/admin
```

A existência de `node-postgres` no projeto não comprova que um PostgreSQL genérico do hPanel fornece PostgreSQL 17, RLS, roles, grants, triggers, funções, constraints compostas e usuários separados. O banco do hPanel não será usado sem uma validação específica desses requisitos.

## Operação, restart e rollback

Confirmar no hPanel antes de publicar:

- processo persistente;
- reinício automático após saída não zero;
- timeout de proxy superior a 60 segundos e compatível com o caso de uso do chat;
- logs stdout/stderr e retenção;
- health checks HTTP para live e ready;
- saída TLS para todos os serviços externos;
- variáveis secretas separadas por ambiente;
- backup e restauração do PostgreSQL externo.

Rollback da aplicação:

1. manter o artefato anterior identificável por commit;
2. apontar o processo para o artefato anterior;
3. reiniciar o processo;
4. validar live e ready;
5. investigar migrations separadamente.

Não fazer rollback de código e migration de forma independente sem verificar compatibilidade. Nenhum cutover Neon ou migration de produção faz parte deste runbook.

## Status deste runbook

- Compatibilidade do processo Node/Nitro com o artefato local: `PASS` após build e smoke locais.
- Disponibilidade do Node no hPanel: `UNVERIFIED` até confirmação externa.
- Comando customizado e processo persistente no hPanel: `UNVERIFIED`.
- PostgreSQL fornecido pela Hostinger: `UNVERIFIED`; não recomendado como banco canônico.
- Neon, migration, reconciliação, backup/restore e cutover: `BLOCKED` sem credenciais e autorização operacional.
