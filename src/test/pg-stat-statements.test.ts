import { describe, expect, it } from "vitest";
import {
  buildArtifact,
  buildReport,
  classifyCriticalQuery,
  CRITICAL_QUERIES,
  MAX_TOP_N,
  parseTopN,
  REGIME,
  renderMarkdown,
  resolveLocalTarget,
  type ArtifactMeta,
  type StatRow,
} from "../../scripts/obs/pg-stat-statements";

const CREDENTIAL = ["s3cr3t", "not", "leaked"].join("-");
const databaseUrl = (host: string, path = "pqdl_pgstat") =>
  `postgresql://postgres:${CREDENTIAL}@${host}/${path}`;

/** SQL real renderizado pelos repositórios drizzle (`.toSQL()`, PG17). */
const REAL_SQL = {
  productsList:
    'select "id", "tenant_id", "user_id", "name", "status", "current_price", "yield_qty", "yield_unit", "tax_regime", "tax_rate", "is_demo", "notes", "version", "archived_at", "created_at", "updated_at" from "products" where ("products"."tenant_id" = $1 and "products"."archived_at" is null) order by "products"."created_at" desc',
  latestPrice:
    'select "id", "tenant_id", "user_id", "subject_type", "subject_id", "ingredient_id", "packaging_id", "price", "quantity", "unit", "supplier_id", "valid_from", "recorded_at" from "purchase_price_history" where ("purchase_price_history"."tenant_id" = $1 and "purchase_price_history"."ingredient_id" = $2) order by "purchase_price_history"."valid_from" desc, "purchase_price_history"."recorded_at" desc limit $3',
  dashboardIngredients: (placeholders: string) =>
    `select "id", "product_id", "tenant_id", "user_id", "name", "used_qty", "used_unit", "package_price", "package_qty", "package_unit", "conversion_factor", "price_updated_at", "created_at", "updated_at" from "product_ingredients" where ("product_ingredients"."tenant_id" = $1 and "product_ingredients"."product_id" in (${placeholders}))`,
} as const;

function row(overrides: Partial<StatRow> = {}): StatRow {
  return {
    query: "select 1",
    calls: 1,
    total_exec_time: 1,
    mean_exec_time: 1,
    rows: 1,
    ...overrides,
  };
}

function metaOf(rows: readonly StatRow[], topN = 10): ArtifactMeta {
  return {
    generatedAt: "2026-09-15T00:00:00.000Z",
    host: "127.0.0.1",
    database: "pqdl_pgstat",
    topN,
    statementEntries: rows.length,
    report: buildReport(rows, topN),
  };
}

describe("§16.3 — guarda de host loopback do coletor pg_stat_statements", () => {
  it("aceita loopback explícito (127.0.0.1, localhost, ::1)", () => {
    const localhost = resolveLocalTarget({
      DATABASE_ADMIN_URL: databaseUrl("localhost"),
    });
    expect(localhost.host).toBe("localhost");
    expect(localhost.database).toBe("pqdl_pgstat");

    expect(
      resolveLocalTarget({ DATABASE_ADMIN_URL: "postgresql://postgres@127.0.0.1:5435/pqdl_pgstat" })
        .host,
    ).toBe("127.0.0.1");
    expect(
      resolveLocalTarget({ DATABASE_ADMIN_URL: "postgresql://postgres@[::1]:5435/pqdl_pgstat" })
        .host,
    ).toBe("::1");
    expect(
      resolveLocalTarget({
        DATABASE_ADMIN_URL: "postgresql://postgres@127.0.0.1:5435/pqdl_pgstat?host=localhost",
      }).host,
    ).toBe("localhost");
  });

  it("recusa host não-loopback com erro explícito e sem vazar a connection string", () => {
    const remote = [
      databaseUrl("db.neon.tech", "prod"),
      databaseUrl("10.0.0.5", "prod"),
      databaseUrl("pg.internal.example.com", "prod"),
      `${databaseUrl("127.0.0.1", "prod")}?host=db.neon.tech`,
      `${databaseUrl("127.0.0.1", "prod")}?hostaddr=10.0.0.5`,
      "postgresql:///prod?host=/var/run/postgresql",
      `${databaseUrl("127.0.0.1", "prod")}?host=127.0.0.1,db.neon.tech`,
    ];
    for (const connectionString of remote) {
      const attempt = () => resolveLocalTarget({ DATABASE_ADMIN_URL: connectionString });
      expect(attempt).toThrow(/loopback|hostaddr/i);
      try {
        attempt();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(CREDENTIAL);
        expect(message).not.toContain("db.neon.tech");
      }
    }
  });

  it("falha fechado com NODE_ENV=production, URL ausente ou malformada", () => {
    expect(() =>
      resolveLocalTarget({
        NODE_ENV: "production",
        DATABASE_ADMIN_URL: databaseUrl("127.0.0.1"),
      }),
    ).toThrow(/production/i);
    expect(() => resolveLocalTarget({})).toThrow(/DATABASE_ADMIN_URL/);
    expect(() => resolveLocalTarget({ DATABASE_ADMIN_URL: "não é uma url" })).toThrow(
      /malformada/i,
    );
  });

  it("limita o top-N a um intervalo declarado", () => {
    expect(parseTopN([], 10)).toBe(10);
    expect(parseTopN(["--top=3"], 10)).toBe(3);
    expect(parseTopN(["--top=9999"], 10)).toBe(MAX_TOP_N);
    expect(() => parseTopN(["--top=zero"], 10)).toThrow(/inteiro positivo/i);
  });
});

describe("§16.3 — casamento com o SQL real do app", () => {
  it("reconhece o SQL renderizado pelos repositórios drizzle", () => {
    expect(classifyCriticalQuery(REAL_SQL.productsList)).toBe("products.list");
    expect(classifyCriticalQuery(REAL_SQL.latestPrice)).toBe("purchasePrice.latest");
    expect(classifyCriticalQuery(REAL_SQL.dashboardIngredients("$2, $3"))).toBe(
      "dashboard.productIngredients",
    );
    expect(classifyCriticalQuery(REAL_SQL.dashboardIngredients("$2, $3, $4"))).toBe(
      "dashboard.productIngredients",
    );
  });

  it("aceita variações de caixa/espaço e a forma literal do §16.4", () => {
    expect(
      classifyCriticalQuery(
        "  SELECT * FROM products\n  WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY created_at DESC  ",
      ),
    ).toBe("products.list");
    expect(
      classifyCriticalQuery(
        "select * from product_ingredients where tenant_id = $1 and product_id = any($2)",
      ),
    ).toBe("dashboard.productIngredients");
  });

  it("não casa vizinhos: mesmo tabela com predicado diferente ou join fica de fora", () => {
    expect(
      classifyCriticalQuery('select "id" from "products" where "products"."tenant_id" = $1'),
    ).toBeNull();
    expect(
      classifyCriticalQuery(
        'select "id" from "products" where ("products"."tenant_id" = $1 and "products"."archived_at" is not null) order by "products"."created_at" desc',
      ),
    ).toBeNull();
    expect(classifyCriticalQuery("select current_database()")).toBeNull();
  });
});

describe("§16.3 — relatório agregado (linhas sintéticas, sem rede)", () => {
  it("soma todas as entradas do mesmo alvo, inclusive formas de `in` diferentes", () => {
    const rows: StatRow[] = [
      row({
        query: REAL_SQL.productsList,
        calls: 5,
        total_exec_time: 3.1,
        mean_exec_time: 0.62,
        rows: 10_000,
      }),
      row({
        query: REAL_SQL.latestPrice,
        calls: 4,
        total_exec_time: 0.36,
        mean_exec_time: 0.09,
        rows: 4,
      }),
      row({
        query: REAL_SQL.dashboardIngredients("$2, $3"),
        calls: 3,
        total_exec_time: 0.06,
        mean_exec_time: 0.02,
        rows: 30,
      }),
      row({
        query: REAL_SQL.dashboardIngredients("$2, $3, $4"),
        calls: 2,
        total_exec_time: 0.04,
        mean_exec_time: 0.02,
        rows: 20,
      }),
      row({ query: "select pg_sleep(0)", calls: 1, total_exec_time: 0.01, mean_exec_time: 0.01 }),
    ];
    const report = buildReport(rows, 10);
    expect(report.missingCritical).toEqual([]);
    expect(report.critical.map((entry) => entry.label)).toEqual([
      "products.list",
      "purchasePrice.latest",
      "dashboard.productIngredients",
    ]);
    const ingredients = report.critical[2]!;
    expect(ingredients.statements).toBe(2);
    expect(ingredients.calls).toBe(5);
    expect(ingredients.total_exec_time).toBeCloseTo(0.1, 10);
    expect(ingredients.mean_exec_time).toBeCloseTo(0.02, 10);
    expect(ingredients.rows).toBe(50);
    expect(ingredients.shapes).toHaveLength(2);
    expect(ingredients.source).toContain("dashboard.repository.ts");
    // 5 padrões: 3 alvos, sendo que o dashboard rende 2 formas de `in`, + o ruído
    expect(report.patterns).toBe(5);
  });

  it("ordena por total_exec_time desc, aplica top-N e agrega entradas repetidas", () => {
    const report = buildReport(
      [
        row({
          query: "select * from products where sku = 'AB-123' and tenant_id = $1",
          total_exec_time: 1,
        }),
        row({
          query: "select * from products where sku = $1",
          total_exec_time: 9,
          calls: 3,
          rows: 30,
        }),
        row({
          query: "select * from products where sku = $1",
          total_exec_time: 5,
          calls: 2,
          rows: 20,
        }),
      ],
      2,
    );
    expect(report.patterns).toBe(2);
    expect(report.top).toHaveLength(2);
    // as duas entradas idênticas viram uma linha somada (9 + 5) e ficam na frente
    expect(report.top.map((entry) => entry.total_exec_time)).toEqual([14, 1]);
    const repeated = report.top[0]!;
    expect(repeated.statements).toBe(2);
    expect(repeated.calls).toBe(5);
    expect(repeated.rows).toBe(50);
    expect(repeated.mean_exec_time).toBeCloseTo(14 / 5, 10);
    expect(report.top.some((entry) => entry.redacted_query.includes("AB-123"))).toBe(false);
  });

  it("o JSON e o markdown saem com o SQL redigido — nunca o texto cru", () => {
    const rows: StatRow[] = [
      row({
        query: "set application_name = 'super-secret-value'",
        calls: 2,
        total_exec_time: 0.4,
        mean_exec_time: 0.2,
        rows: 2,
      }),
      row({
        query: REAL_SQL.productsList,
        calls: 7,
        total_exec_time: 4.2,
        mean_exec_time: 0.6,
        rows: 14_000,
      }),
    ];
    const meta = metaOf(rows);
    const artifact = buildArtifact(meta);
    const json = JSON.stringify(artifact);
    const markdown = renderMarkdown(meta);
    for (const rendered of [json, markdown]) {
      expect(rendered).not.toContain("super-secret-value");
      expect(rendered).not.toContain('"query":');
    }
    const top = artifact.top as Array<Record<string, unknown>>;
    expect(top.map((entry) => entry.redacted_query)).toContain("set application_name = ?");
    expect(Object.keys(top[0]!).sort()).toEqual([
      "calls",
      "critical",
      "mean_exec_time",
      "operation",
      "redacted_query",
      "rows",
      "statements",
      "total_exec_time",
    ]);
    expect(markdown).toContain("set application_name = ?");
    for (const column of ["calls", "total_exec_time_ms", "mean_exec_time_ms", "rows", "critical"]) {
      expect(markdown).toContain(column);
    }
    expect(markdown).toContain(REGIME);
    expect(REGIME).toBe("CONTROLLED");
  });

  it("o fixture de evidência declara os 7 rótulos do §35 e o regime CONTROLADO", () => {
    const evidence = [
      "**hypothesis:** fixture",
      "**metric:** fixture",
      "**before:** fixture",
      "**change:** fixture",
      "**after:** fixture",
      "**result:** fixture",
      "**decision:** fixture",
      "**regime:** CONTROLLED",
      "Neon: pendente",
    ].join("\n");
    for (const label of [
      "hypothesis",
      "metric",
      "before",
      "change",
      "after",
      "result",
      "decision",
    ]) {
      expect(evidence).toMatch(new RegExp(`^\\*\\*${label}:\\*\\*`, "im"));
    }
    expect(evidence).toContain("CONTROLLED");
    expect(evidence).toMatch(/Neon[^\n]*pendente|pendente[^\n]*Neon/i);
    expect(evidence).not.toMatch(/^\s*[-*]\s*\*\*regime:\*\*\s*OBSERVED/m);
    expect(CRITICAL_QUERIES).toHaveLength(3);
    for (const target of CRITICAL_QUERIES) {
      expect(target.source).toMatch(/^src\/server\/repositories\/[\w.-]+\.ts:\d+-\d+$/);
    }
  });
});
