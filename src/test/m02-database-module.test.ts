import { describe, expect, it } from "vitest";
import { isDatabaseModule } from "../../scripts/lib/m02-database-module";

describe("classificador de módulo de banco da matriz M-02 (WP-R6)", () => {
  it("reconhece o driver e o diretório @/db", () => {
    expect(isDatabaseModule("drizzle-orm")).toBe(true);
    expect(isDatabaseModule("drizzle-orm/pg-core")).toBe(true);
    expect(isDatabaseModule("@/db/client.server")).toBe(true);
    expect(isDatabaseModule("@/db/schema")).toBe(true);
  });

  it("reconhece caminho relativo cujo diretório é db", () => {
    expect(isDatabaseModule("./db/client.server")).toBe(true);
    expect(isDatabaseModule("../db/schema")).toBe(true);
    expect(isDatabaseModule("../../src/db/schema")).toBe(true);
  });

  it("NÃO conta caminho que apenas contém 'db' no nome (o falso positivo do WP-R6)", () => {
    // A regra anterior (`\.\.?\/.*db.*`) casava todos estes e inflava `directDatabaseFiles`.
    expect(isDatabaseModule("./helpers/db-precondition")).toBe(false);
    expect(isDatabaseModule("./helpers/database-precondition")).toBe(false);
    expect(isDatabaseModule("./debug/tools")).toBe(false);
    expect(isDatabaseModule("./dbml-parser")).toBe(false);
    expect(isDatabaseModule("./s3db-client")).toBe(false);
  });

  it("não confunde módulos externos nem specs sem caminho", () => {
    expect(isDatabaseModule("pg")).toBe(false);
    expect(isDatabaseModule("node:fs")).toBe(false);
    expect(isDatabaseModule("vitest")).toBe(false);
    expect(isDatabaseModule("./db")).toBe(true);
  });

  it("a fronteira é o segmento: `db` no meio sem ser diretório final não conta", () => {
    expect(isDatabaseModule("./foo/db-bar/baz")).toBe(false);
    expect(isDatabaseModule("./foo/db/bar")).toBe(true);
  });
});
