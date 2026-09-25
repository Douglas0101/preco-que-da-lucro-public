import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { ConfigEnv, PluginOption } from "vite";

// Uma única fonte para "estamos buildando para a Vercel": ela escolhe o preset do Nitro e o
// gate do `@vercel/analytics` (src/lib/vercel-analytics.ts).  Localmente (e na CI) `VERCEL`
// não existe ⇒ preset `node-server`, onde `/_vercel/insights/script.js` não é servido.
const isVercel = Boolean(process.env.VERCEL);

const lovableConfig = defineConfig({
  // The BFF is deployed as a Node server (Neon/Better Auth), and CI's
  // Playwright webServer starts the generated Nitro output directly.  The
  // Lovable default targets Cloudflare, which leaves `nitro preview` trying
  // to start Wrangler and makes the preview health check time out.  Vercel
  // builds (VERCEL=1) emit the Build Output API (`.vercel/output`) instead.
  nitro: { preset: isVercel ? "vercel" : "node-server" },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // Split each route into its own chunk so the initial bundle only carries
    // the visited route (plan mestre §17.6).
    router: { autoCodeSplitting: true },
  },
  vite: {
    environments: {
      client: {
        build: {
          manifest: true,
          rolldownOptions: {
            output: {
              codeSplitting: {
                groups: [
                  {
                    name: "tanstack-vendor",
                    test: /node_modules[\\/]@tanstack[\\/](?:history|query-core|react-query|react-router|router-core|store)[\\/]/,
                    priority: 10,
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
});

function isLegacyTsconfigPathsPlugin(plugin: PluginOption) {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    !Array.isArray(plugin) &&
    "name" in plugin &&
    (plugin.name === "vite-tsconfig-paths" || plugin.name === "vite-plugin-tsconfig-paths")
  );
}

export default async function config(env: ConfigEnv) {
  const resolved = await lovableConfig(env);

  return {
    ...resolved,
    // Substituição literal, visível ao bundle **cliente** (que decide em runtime se monta o
    // `<Analytics />`).  Mesma origem do preset acima — gate e preset não podem divergir.
    define: {
      ...resolved.define,
      __VERCEL_ANALYTICS_ENABLED__: JSON.stringify(isVercel),
    },
    plugins: resolved.plugins?.filter((plugin) => !isLegacyTsconfigPathsPlugin(plugin)),
    resolve: {
      ...resolved.resolve,
      tsconfigPaths: true,
    },
  };
}
