import { mkdir } from "node:fs/promises";
import { request } from "@playwright/test";

export const authStatePath = ".artifacts/e2e-auth.json";

export default async function globalSetup() {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
  const email = process.env.E2E_AUTH_EMAIL ?? "";
  const password = process.env.E2E_AUTH_PASSWORD ?? "";

  if (!email || !password) {
    throw new Error("E2E_AUTH_EMAIL e E2E_AUTH_PASSWORD são obrigatórios para o setup global.");
  }

  await mkdir(".artifacts", { recursive: true });
  const context = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      origin: baseURL,
      "sec-fetch-site": "same-origin",
      // The preview server is reached directly by Playwright, without the
      // reverse proxy that supplies the client IP in deployed environments.
      // Keep the setup login in its own deterministic bucket.
      "x-forwarded-for": "198.51.100.10",
    },
  });

  try {
    const response = await context.post("/api/auth/sign-in/email", {
      data: { email, password },
    });
    if (!response.ok()) {
      throw new Error(`Falha ao autenticar a suíte E2E: HTTP ${response.status()}.`);
    }
    await context.storageState({ path: authStatePath });
  } finally {
    await context.dispose();
  }
}
