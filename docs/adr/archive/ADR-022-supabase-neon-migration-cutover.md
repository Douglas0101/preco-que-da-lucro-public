# ADR-022 (arquivado) — Migração Supabase → Neon e cutover sem dual-write

- Status: superseded; mantido somente como histórico do lote intermediário
- Data: 2026-08-12
- Escopo: migração, reconciliação, rollback e release

## Contexto

O runtime legado mantém usuários, identidades e dados de negócio no Supabase. O estado final usa PostgreSQL no Neon e Better Auth, preservando UUIDs e hashes bcrypt, mas não sessões antigas. A migração precisa ser repetível em develop e ter um ponto de não retorno claro em produção.

## Decisão

1. `SUPABASE_MIGRATION_DATABASE_URL` existe somente no processo de migração e deve permitir leitura direta de `auth` e `public`. O script abre `REPEATABLE READ READ ONLY` e nunca executa escrita na origem.
2. Migrations Drizzle são aplicadas antes do import. Por padrão o import executa e reconcilia dentro de uma transação de destino, mas faz rollback. Escrita real exige `MIGRATION_APPLY=true`.
3. UUIDs de usuários e registros de negócio são preservados. Tenant pessoal e conversa recebem UUID determinístico derivado do UUID do usuário, permitindo dry runs repetíveis.
4. Hash bcrypt de `auth.users.encrypted_password` vira a conta `credential`. Identidades externas viram contas do provedor sem importar access token, refresh token ou sessão. Senhas futuras usam scrypt.
5. Percentuais legados em pontos percentuais são divididos por 100. Dinheiro e quantidades são convertidos para as escalas canônicas com `ROUND_HALF_UP`.
6. O import falha fechado para usuário sem e-mail, ownership divergente, role de chat inválida, órfão, total financeiro divergente, contagem divergente ou checksum amostral divergente.
7. O relatório contém contagem, diferença, nulos, timestamps mínimo/máximo, total financeiro, órfãos e SHA-256 dos primeiros 100 IDs por tabela. Diferença exige exceção documentada e aprovação antes do cutover.
8. Produção entra em manutenção/read-only antes do export final. Não existe dual-write.
9. Antes da primeira escrita no Neon, falha permite restaurar o runtime Supabase. Depois da primeira escrita, rollback usa snapshot/PITR do Neon.
10. A origem Supabase fica congelada por 14 dias. Desativar ou excluir exige aprovação explícita do proprietário.

## Consequências

- Todos os usuários autenticam novamente no novo runtime.
- `MIGRATION_ALLOW_UPSERT=true` é excepcional e só serve para um dry run revisado ou repetição controlada; o padrão recusa destino não vazio.
- A release `develop → main` permanece bloqueada sem URLs, dry run Neon develop e reconciliação com diferença zero.
