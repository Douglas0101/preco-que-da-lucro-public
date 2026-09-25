# ADR-021 (arquivado) — Taxonomia de erros, segurança da IA e observabilidade

- Status: superseded; mantido somente como histórico do lote intermediário
- Data: 2026-08-12
- Escopo: BFF, tools, gateway de IA e operação

## Contexto

O runtime legado convertia argumentos de tools por casts, devolvia mensagens internas do gateway e mantinha I/O de IA sem timeout, idempotência ou auditoria durável. Também não existia uma correlação única entre HTTP, BFF, banco e modelo.

## Decisão

1. Toda falha pública usa um dos códigos `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT`, `DATABASE_ERROR`, `DEPENDENCY_ERROR`, `AI_TIMEOUT`, `AI_QUOTA` ou `INTERNAL_ERROR`, com mensagem segura, `retryable` e `correlationId`.
2. `x-correlation-id` só é propagado quando é UUID válido; caso contrário, o servidor gera um UUID. Server functions autenticadas usam `private, no-store` e `Vary: Cookie`.
3. Logs são JSON e passam por redaction recursiva de cookies, autorizações, tokens, segredos, senhas, URLs de banco, hashes e PII. Causas internas nunca entram na resposta.
4. As dez tools formam um registro fechado. Cada definição contém JSON Schema derivado do schema Zod, autorização e executor tipado. O fluxo é parse, `safeParse`, AuthZ, idempotência, service, persistência de `ToolExecution` e evento de auditoria.
5. Tool rejeitada ou replay conflitante não executa mutação. Replays bem-sucedidos devolvem apenas o resultado seguro persistido.
6. Chat usa transações PostgreSQL curtas antes e depois do I/O externo. O gateway nunca mantém uma transação aberta. O sinal de cancelamento atravessa a chamada ao modelo e a execução de tools.
7. Limites padrão são 60 segundos por solicitação, 30 segundos por modelo, oito rodadas de tools, duas tentativas totais para falhas transitórias, 20 chats por usuário em dez minutos e 200 chats diários por tenant. Todos são configuráveis dentro de limites fechados.
8. OpenTelemetry cria spans manuais para request, transação tenant, modelo e tool. OTLP é opt-in por ambiente; falha de inicialização ou exportação não bloqueia requests.
9. Métricas cobrem duração HTTP/DB/IA/tool, erros por código, timeout, quota, execução de tools e estados financeiros. `/api/health/live` verifica processo e `/api/health/ready` depende de `select 1` no PostgreSQL.
10. CSP inicia em Report-Only. Enforcement exige `CSP_ENFORCE=true` depois da validação em staging. HSTS é exclusivo de produção; `nosniff`, Referrer-Policy, Permissions-Policy e `frame-ancestors` são aplicados pelo middleware global.

## Consequências

- A UI pode mostrar uma referência de atendimento sem conhecer stack, SQL ou payload interno.
- Falhas de validação, autorização e conflito nunca entram no mecanismo de retry.
- O custo diário é controlado inicialmente por quantidade e tokens; custo monetário só será contabilizado quando o adapter do provedor entregar uma tarifa confiável.
- O exporter OTLP e o endpoint de coleta continuam opcionais; logs e health permanecem operacionais sem collector.
