# Definition of Done M-02

- `matrix.yaml` compilada por `tsx scripts/m02-matrix.ts` e sem drift;
- inventário separa `transactionSites` de `directDatabaseFiles` (baseline atual:
  13 e 21, respectivamente), sem tratar arquivos alcançáveis como sites
  transacionais;
- todos os endpoints concretos, aliases, children e rotas auxiliares classificados;
- todos os sites de transação gerados pela matriz classificados, removidos ou
  explicitamente limitados ao fallback de um repository/compatibility facade;
- nenhum BFF de domínio alcança DB fora da allowlist;
- services/repositories recebem contexto de tenant do servidor e `Executor`;
- nenhum cálculo financeiro canônico permanece em rota React;
- DTOs financeiros usam strings/escala declaradas;
- paridade antiga/nova aprovada antes de remover adapters;
- testes de tenant, boundary, status, decimal, golden, E2E e query count verdes;
- `m02:boundaries` valida a consistência das contagens, a unicidade dos arquivos
  de persistência, a forma dos sites transacionais e as seis unidades de chat;
- ledger registra SHA, ambiente, comando e artefato;
- spec só é `FROZEN` após aprovação humana.
