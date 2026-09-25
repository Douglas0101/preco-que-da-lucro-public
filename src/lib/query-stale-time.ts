// staleTime por natureza do dado (plano §17.5) — constantes puras, sem
// dependências, para que módulos eager (router.tsx) não arrastem a cadeia
// *.functions/zod para o grafo inicial (orçamento de bundle §17.7).
export const AGGREGATE_STALE_TIME = 60_000; // agregados/dashboard: custo de agregação alto e mudança lenta
export const OPERATIONAL_STALE_TIME = 30_000; // listas operacionais: precisam refletir ações recentes do usuário
export const REALTIME_STALE_TIME = 0; // chat: quase em tempo real, sempre considerado stale
