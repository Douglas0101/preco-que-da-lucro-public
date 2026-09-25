# ADR-020 — Better Auth e sessões server-driven

- Status: aceito
- Data: 2026-08-12
- Escopo: autenticação do BFF

## Contexto

O runtime legado persiste uma sessão Supabase no navegador e anexa um bearer token às server functions. O P0 exige autenticação auto-hospedada, sessão opaca revogável no PostgreSQL e ausência de token em Web Storage.

## Decisão

1. Better Auth é montado pelo TanStack Start em `/api/auth/*` com o adapter Drizzle e as tabelas PostgreSQL canônicas.
2. O navegador recebe somente o token opaco de sessão em cookie `HttpOnly`, `SameSite=Lax`, `Path=/` e host-only. Produção usa `Secure` e o prefixo `__Host-`; desenvolvimento HTTP usa um nome sem esse prefixo.
3. Cookie cache de sessão fica desabilitado. Cada validação privada consulta a sessão revogável no PostgreSQL.
4. E-mail/senha exige confirmação de e-mail. Recuperação de senha revoga sessões e usa um adapter Resend isolado.
5. Hashes bcrypt importados são aceitos pelo verificador legado. Senhas novas e alteradas são gravadas com o scrypt do Better Auth.
6. Google OAuth é habilitado somente quando client ID e secret coexistem. Origens são allowlist exata; `state` e PKCE são fornecidos pelo fluxo nativo do Better Auth.
7. Login sempre emite uma sessão nova. Reset e troca de senha invalidam tokens anteriores; troca de role invalida todas as sessões do usuário afetado. Logout global revoga as sessões no servidor antes de limpar o cookie.
8. Todo usuário novo recebe um tenant pessoal na criação. Usuários importados e suas identidades serão associados pelo processo de migração, sem importar sessões antigas.
9. Server functions privadas recebem `RequestContext` construído da sessão e de membership verificada. Um `tenant_id` vindo do body nunca é autoridade; um seletor por header só é aceito após confirmar a membership no banco.

## Ativação

A rota Better Auth e o middleware BFF podem coexistir com o runtime legado durante os PRs intermediários. A interface atual só troca de provedor depois do dry run reconciliado no Neon develop. No cutover, os clientes Supabase, o bearer attacher e a inspeção de storage são removidos juntos.

## Consequências

- `BETTER_AUTH_SECRET`, URLs/origens, Google OAuth e Resend são pré-requisitos externos por ambiente.
- A indisponibilidade do e-mail impede fluxos que dependem de verificação, sem degradar para sucesso vazio.
- Alterações de autorização têm custo de revogação de sessões, deliberadamente priorizando consistência e segurança.
