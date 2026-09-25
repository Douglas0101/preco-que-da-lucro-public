import { sql } from "drizzle-orm";
import { createFileRoute } from "@tanstack/react-router";
import { getDatabase } from "@/db/client.server";
import { logJson } from "@/lib/structured-logger";

async function readiness(): Promise<Response> {
  try {
    await getDatabase().execute(sql`select 1 as ready`);
    return Response.json(
      { status: "ready", dependencies: { postgres: "ok" } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    logJson("error", "health.readiness_failed", { dependency: "postgres", error });
    return Response.json(
      { status: "not_ready", dependencies: { postgres: "unavailable" } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/health/ready")({
  server: { handlers: { GET: readiness } },
});
