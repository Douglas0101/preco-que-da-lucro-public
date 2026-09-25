import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/server/auth/auth.server";

async function handleAuthRequest({ request }: { request: Request }): Promise<Response> {
  const response = await getAuth().handler(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.append("Vary", "Cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handleAuthRequest,
      POST: handleAuthRequest,
    },
  },
});
