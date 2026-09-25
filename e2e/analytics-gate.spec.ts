import { expect, test } from "@playwright/test";

const INSIGHTS_PREFIX = "/_vercel/insights/";

/**
 * Invariante `preset Nitro ≡ gate do analytics` (F-B1-e2e).
 *
 * O preview do Playwright é o preset `node-server` (sem `VERCEL`), onde
 * `/_vercel/insights/script.js` não existe. Se o gate `__VERCEL_ANALYTICS_ENABLED__`
 * divergir do preset — ex.: um build de Vercel passando por engano local, ou o
 * `define` de `vite.config.ts` trocado —, o `<Analytics />` monta e injeta o
 * script: o browser faz a requisição e leva 404 com `text/html` sob `nosniff`.
 *
 * A asserção é comportamental e ancorada na hidratação de verdade: o listener é
 * instalado ANTES do `goto`, o teste espera o marcador de raiz do React (o entry
 * do cliente chama `hydrateRoot(document)`) e só então exige zero requisições ao
 * prefixo de insights. Um sleep fixo poderia passar antes de o efeito de injeção
 * ter chance de rodar (S6 N1); a espera por marcador falha alto se a hidratação
 * não acontecer.
 */
test("o preview node-server nao requisita /_vercel/insights/*", async ({ page }) => {
  const documentos: string[] = [];
  const insights: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/") documentos.push(url.href);
    if (url.pathname.startsWith(INSIGHTS_PREFIX)) insights.push(url.href);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /entenda a faixa de preço/i })).toBeVisible();

  // Marcador de hidratação: `hydrateRoot` marca o container com
  // `__reactContainer$<id>`. Sem ele, a medição não vale — falhar é o correto.
  await page.waitForFunction(
    () => {
      const alvos: Array<Record<string, unknown>> = [
        document as unknown as Record<string, unknown>,
      ];
      if (document.documentElement) {
        alvos.push(document.documentElement as unknown as Record<string, unknown>);
      }
      return alvos.some((alvo) =>
        Object.keys(alvo).some((chave) => chave.startsWith("__reactContainer$")),
      );
    },
    undefined,
    { timeout: 15_000 },
  );

  // Dois frames após o commit: os efeitos (a injeção acontece no `useEffect`)
  // já rodaram e qualquer requisição divergente já saiu.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  expect(
    documentos.length,
    "o listener tem de ter visto o documento (instalado antes do goto)",
  ).toBeGreaterThan(0);
  expect(insights, `insights requisitados: ${insights.join(", ")}`).toEqual([]);

  // `typeof` devolve string: a asserção é serializável (uma função não é — S6 N2).
  const vaType = await page.evaluate(() => typeof (window as unknown as { va?: unknown }).va);
  expect(vaType, "window.va é instalado pelo @vercel/analytics quando ele monta").toBe("undefined");
});
