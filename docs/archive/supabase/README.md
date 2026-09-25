# Arquivo histórico da origem legada

Estes arquivos registram o schema anterior somente para auditoria e para apoiar
o processo único, read-only, de migração para PostgreSQL/Neon. Eles não são
carregados pelo build, pelo runtime, pelo Drizzle ou pelo CI.

A cadeia canônica de schema está em `drizzle/`. A origem legada permanece
congelada durante a janela de 14 dias após o cutover e só pode ser desativada ou
excluída mediante aprovação explícita.
