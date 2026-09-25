# ADR-022 — Taxonomia de erros e observabilidade do P0

- Status: aceita
- Data: 2026-08-12
- Escopo: request, BFF, services, repositories, PostgreSQL e IA

## Contexto

Erros de validação, autorização, domínio, banco e dependências exigem respostas e retries distintos. Mensagens genéricas impedem suporte; detalhes internos e PII em respostas ou logs criam risco. O fluxo também precisa ser rastreável entre navegador, BFF, banco e gateway de IA.

## Decisão

1. O contrato público usa `ApiResult<T>` e `ApiError` com `code`, mensagem segura, `retryable` e `correlationId`.
2. Os códigos permitidos são `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT`, `DATABASE_ERROR`, `DEPENDENCY_ERROR`, `AI_TIMEOUT`, `AI_QUOTA` e `INTERNAL_ERROR`.
3. Stack, SQL, payloads internos e causas ficam somente em logs estruturados. Respostas nunca expõem segredo ou detalhe de infraestrutura.
4. Toda requisição recebe ou propaga `x-correlation-id`; o mesmo identificador acompanha contexto, transação, logs, spans, auditoria de tools e resposta.
5. Logs são JSON com redaction de cookies, tokens, senhas, URLs de banco, hashes e PII conhecida.
6. OpenTelemetry mede request → BFF → service → repository/DB → IA. Exportação OTLP é opt-in e falha de telemetria nunca bloqueia request.
7. Métricas cobrem estados financeiros, latências, timeouts, quotas, tools e erros por código, sem labels de alta cardinalidade ou PII.
8. Queries autenticadas não recebem retry automático no cliente. Validação, autenticação, autorização e conflito nunca são repetidos automaticamente; somente falhas transitórias explicitamente classificadas podem seguir política limitada.
9. `/api/health/live` comprova processo vivo; `/api/health/ready` executa consulta mínima ao PostgreSQL e pode retirar a instância de serviço.

## Segurança operacional

- `Cache-Control: private, no-store` e `Vary: Cookie` protegem respostas autenticadas;
- logs e auditoria armazenam somente resultados sanitizados;
- limites de IA e idempotência são aplicados antes da mutação;
- alertas devem agregar por código e componente, nunca por identificador pessoal.

## Consequências

Falhas deixam de ser convertidas em listas vazias ou zeros. A UI pode distinguir erro técnico de `incomplete` e `invalid`, e o suporte consegue correlacionar eventos sem expor detalhes ao usuário. Telemetria real e SLOs continuam dependentes do ambiente de deploy; métricas locais não substituem baseline operacional.
