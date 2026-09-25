/**
 * Alvo do `@vercel/analytics` decidido em **build**, pela mesma origem que escolhe o preset do
 * Nitro em `vite.config.ts` (`process.env.VERCEL`): com `VERCEL=1` o preset é `vercel` e o
 * `/_vercel/insights/script.js` é servido pela plataforma; sem ela o preset é `node-server`,
 * onde esse caminho não existe — montar o componente lá injeta um `<script>` que responde
 * **404 + recusa por MIME** (`text/html` sob `X-Content-Type-Options: nosniff`) em toda
 * navegação (achado B-1, ciclo 3).
 *
 * O bundle **cliente** precisa da resposta antes de rodar no browser, então o valor chega
 * substituído literalmente pelo Vite (`__VERCEL_ANALYTICS_ENABLED__`, ver `vite.config.ts`) —
 * nenhuma dependência nova, nenhum relaxamento da CSP estrita (`script-src 'self'`).
 *
 * O guarda `typeof` cobre ambientes que não passam pelo `define` (ex.: vitest): ali o valor é
 * desconhecido e a resposta segura é **desligado** — nunca injetar um script que pode não existir.
 */
declare const __VERCEL_ANALYTICS_ENABLED__: boolean;

export const vercelAnalyticsEnabled =
  typeof __VERCEL_ANALYTICS_ENABLED__ === "boolean" && __VERCEL_ANALYTICS_ENABLED__;
