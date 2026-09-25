import { defineConfig } from "drizzle-kit";

const adminUrl = process.env.DATABASE_ADMIN_URL;

if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL é obrigatória para migrations");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: adminUrl },
  strict: true,
  verbose: true,
});
