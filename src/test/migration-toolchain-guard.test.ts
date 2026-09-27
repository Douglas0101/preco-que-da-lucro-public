/**
 * Controles negativos do `migration-toolchain-guard`.
 *
 * Todos os casos partem de um input válido e alteram **um** campo, afirmando a
 * finding específica. O núcleo (`auditMigrationToolchain`) é puro: recebe dados
 * já lidos, não toca `fs`, não abre conexão e não precisa de um segundo
 * `node_modules` para ser falsificado — por isso estes testes são herméticos e
 * reais (se a lógica saísse, eles reprovariam).
 */
import { describe, expect, it } from "vitest";

import type { MigrationToolchainInput } from "../../scripts/lib/migration-toolchain-guard";
import {
  auditMigrationToolchain,
  compareVersions,
  inRange,
} from "../../scripts/lib/migration-toolchain-guard";

const baseInput = (): MigrationToolchainInput => ({
  policyMin: "0.31.0",
  policyMax: "0.31.99",
  installedVersion: "0.31.10",
  typesText: "export declare function defineConfig(config: unknown): unknown;",
  configModule: { dialect: "postgresql", out: "./drizzle", schema: "./src/db/schema.ts" },
  configError: null,
  migrations: [
    {
      file: "drizzle/0000_p0_postgres_foundation.sql",
      classificada: true,
      classificacao: "SAFE",
    },
    {
      file: "drizzle/0001_p0_runtime_role_and_rls.sql",
      classificada: true,
      classificacao: "ONLINE_WITH_CARE",
    },
  ],
  envNames: ["DATABASE_URL", "DATABASE_ADMIN_URL", "DATABASE_DRIVER"],
});
/** A finding de um lado específico, sem depender de ordem nem de comprimento. */
const findingFor = (
  input: MigrationToolchainInput,
  side: string,
  pkg = "drizzle-kit",
): string | undefined =>
  auditMigrationToolchain(input).find((f) => f.startsWith(pkg + " (" + side + "):"));

describe("faixa da política (drizzle-kit)", () => {
  it("input válido não produz finding alguma", () => {
    expect(auditMigrationToolchain(baseInput())).toEqual([]);
  });

  it("política sem o pacote (min/max vazios) reprova", () => {
    const findings = auditMigrationToolchain({ ...baseInput(), policyMin: "", policyMax: "" });
    expect(findingFor({ ...baseInput(), policyMin: "", policyMax: "" }, "policy")).toContain(
      "observado entrada ausente ou com min/max ilegível (min='', max='')",
    );
    expect(findings.some((f) => f.includes("scripts/dependency-policy.json"))).toBe(true);
  });

  it("faixa invertida (min > max) reprova como degenerada", () => {
    const inverted = { ...baseInput(), policyMin: "0.31.99", policyMax: "0.31.0" };
    expect(findingFor(inverted, "policy")).toContain(
      "observado faixa degenerada min='0.31.99' max='0.31.0', esperado min < max",
    );
  });

  it("faixa vazia (min === max) reprova como degenerada", () => {
    const empty = { ...baseInput(), policyMin: "0.31.10", policyMax: "0.31.10" };
    expect(findingFor(empty, "policy")).toContain("faixa degenerada min='0.31.10' max='0.31.10'");
  });

  it("min/max não numéricos reprovam", () => {
    const bogus = { ...baseInput(), policyMin: "latest", policyMax: "0.31.99" };
    expect(findingFor(bogus, "policy")).toContain("min='latest'");
  });
});

describe("versão instalada", () => {
  it("toolchain não instalada reprova com 'toolchain não instalada'", () => {
    const uninstalled = { ...baseInput(), installedVersion: null };
    expect(findingFor(uninstalled, "installed")).toContain(
      "observado ausente (toolchain não instalada em node_modules)",
    );
  });

  it("0.18.1 com min 0.31.0 reprova por DOWNGRADE", () => {
    const downgraded = { ...baseInput(), installedVersion: "0.18.1" };
    expect(findingFor(downgraded, "installed")).toBe(
      "drizzle-kit (installed): observado 0.18.1, esperado >=0.31.0 (downgrade abaixo do mínimo aprovado 0.31.0..0.31.99)",
    );
  });

  it("0.32.0 reprova como fora da faixa aprovada, e NÃO como downgrade", () => {
    const above = { ...baseInput(), installedVersion: "0.32.0" };
    const finding = findingFor(above, "installed");
    expect(finding).toBe(
      "drizzle-kit (installed): observado 0.32.0, esperado <=0.31.99 (fora da faixa aprovada 0.31.0..0.31.99)",
    );
    expect(finding).not.toContain("downgrade");
  });

  it("os limites da faixa são inclusivos", () => {
    expect(findingFor({ ...baseInput(), installedVersion: "0.31.0" }, "installed")).toBeUndefined();
    expect(
      findingFor({ ...baseInput(), installedVersion: "0.31.99" }, "installed"),
    ).toBeUndefined();
  });
});

describe("símbolo defineConfig na toolchain", () => {
  it("tipos sem defineConfig reprovam dizendo que a versão é anterior ao símbolo", () => {
    const noSymbol = {
      ...baseInput(),
      typesText: "export declare function define(): void;\nexport declare function push(): void;",
    };
    expect(findingFor(noSymbol, "types")).toBe(
      "drizzle-kit (types): observado tipos sem defineConfig, esperado defineConfig declarado — a versão instalada é anterior ao símbolo importado por drizzle.config.ts",
    );
  });

  it("toolchain ausente (typesText nulo) é finding DISTINTA da ausência do símbolo", () => {
    const missingTypes = { ...baseInput(), typesText: null };
    const finding = findingFor(missingTypes, "types");
    expect(finding).toContain("observado arquivo de tipos não encontrado em node_modules");
    expect(finding).not.toContain("anterior ao símbolo");
  });

  it("O INCIDENTE REAL (0.18.1 sem defineConfig) reprova por duas razões independentes", () => {
    const incident = {
      ...baseInput(),
      installedVersion: "0.18.1",
      typesText: "export declare function define(): void;",
    };
    const findings = auditMigrationToolchain(incident);
    expect(findingFor(incident, "installed")).toContain("downgrade");
    expect(findingFor(incident, "types")).toContain(
      "a versão instalada é anterior ao símbolo importado por drizzle.config.ts",
    );
  });
});

describe("drizzle.config.ts", () => {
  it("erro de load reprova com a mensagem do erro", () => {
    const broken = {
      ...baseInput(),
      configModule: null,
      configError: "does not provide an export named 'defineConfig'",
    };
    expect(findingFor(broken, "drizzle.config.ts")).toBe(
      "drizzle-kit (drizzle.config.ts): observado erro ao carregar: does not provide an export named 'defineConfig', esperado config carregável (defineConfig presente e objeto válido)",
    );
  });

  it("configModule nulo sem erro de load reprova separadamente", () => {
    const noDefault = { ...baseInput(), configModule: null };
    expect(findingFor(noDefault, "drizzle.config.ts")).toBe(
      "drizzle-kit (drizzle.config.ts): observado módulo sem default export, esperado default export de drizzle.config.ts",
    );
  });

  it("dialect sqlite reprova nomeando o valor observado", () => {
    const sqlite = {
      ...baseInput(),
      configModule: { dialect: "sqlite", out: "./drizzle", schema: "s" },
    };
    expect(findingFor(sqlite, "drizzle.config.ts")).toBe(
      "drizzle-kit (drizzle.config.ts): observado dialect='sqlite', esperado dialect='postgresql'",
    );
  });

  it("out fora de ./drizzle reprova nomeando o valor observado", () => {
    const wrongOut = {
      ...baseInput(),
      configModule: { dialect: "postgresql", out: "./db/migrations", schema: "s" },
    };
    expect(findingFor(wrongOut, "drizzle.config.ts")).toBe(
      "drizzle-kit (drizzle.config.ts): observado out='./db/migrations', esperado out='./drizzle'",
    );
  });
});

describe("migrations classificadas", () => {
  it("descoberta vazia NÃO é aprovação", () => {
    const none = { ...baseInput(), migrations: [] };
    expect(findingFor(none, "migrations", "drizzle")).toBe(
      "drizzle (migrations): observado 0 arquivos em drizzle/*.sql, esperado ao menos uma migration classificada (descoberta vazia não é aprovação)",
    );
  });

  it("migration sem classificação reprova nomeando o arquivo", () => {
    const unclassified = {
      ...baseInput(),
      migrations: [
        ...baseInput().migrations,
        { file: "drizzle/0003_curvy_firebrand.sql", classificada: false, classificacao: null },
      ],
    };
    const finding = findingFor(unclassified, "migrations", "drizzle");
    expect(finding).toBe(
      "drizzle (migrations): observado drizzle/0003_curvy_firebrand.sql sem classificação, esperado entrada classificada em scripts/db/migration-classes.ts",
    );
  });

  it("classificação fora da taxonomia de migration-classes.ts reprova", () => {
    const bogus = {
      ...baseInput(),
      migrations: [
        {
          file: "drizzle/0000_p0_postgres_foundation.sql",
          classificada: true,
          classificacao: "TRABUCO",
        },
      ],
    };
    expect(findingFor(bogus, "migrations", "drizzle")).toBe(
      "drizzle (migrations): observado drizzle/0000_p0_postgres_foundation.sql com classificação 'TRABUCO' fora da taxonomia, esperado uma de SAFE, ONLINE_WITH_CARE, DATA_MIGRATION, BREAKING",
    );
  });

  it("classificada sem rótulo (null) também reprova", () => {
    const noLabel = {
      ...baseInput(),
      migrations: [{ file: "drizzle/0000_x.sql", classificada: true, classificacao: null }],
    };
    expect(findingFor(noLabel, "migrations", "drizzle")).toContain(
      "com classificação 'null' fora da taxonomia",
    );
  });
});

describe("ambiente declarado (.env.example)", () => {
  it("sem DATABASE_ADMIN_URL reprova nomeando o que falta", () => {
    const pooledOnly = { ...baseInput(), envNames: ["DATABASE_URL", "DATABASE_DRIVER"] };
    expect(findingFor(pooledOnly, "env.example")).toBe(
      "drizzle-kit (env.example): observado sem DATABASE_ADMIN_URL (declarados: DATABASE_URL, DATABASE_DRIVER), esperado DATABASE_URL (pooled, runtime) e DATABASE_ADMIN_URL (direct, migrations) declarados em .env.example",
    );
  });

  it("sem as duas reprova nomeando as duas", () => {
    const none = { ...baseInput(), envNames: [] };
    expect(findingFor(none, "env.example")).toContain(
      "observado sem DATABASE_URL, DATABASE_ADMIN_URL (declarados: nenhum)",
    );
  });
});

describe("comparação de versão sem dependência externa", () => {
  it("0.9.0 < 0.10.0 (comparação numérica, não lexicográfica)", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  });

  it("pre-release é ignorado: 0.31.10-rc.1 equivale a 0.31.10", () => {
    expect(compareVersions("0.31.10-rc.1", "0.31.10")).toBe(0);
    expect(compareVersions("0.31.10", "0.31.10-rc.1")).toBe(0);
  });

  it("build metadata é ignorado", () => {
    expect(compareVersions("0.31.10+build.7", "0.31.10")).toBe(0);
  });

  it("major domina minor e patch", () => {
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.31.9", "0.31.10")).toBe(-1);
    expect(compareVersions("0.31.10", "0.31.10")).toBe(0);
  });

  it("versão ilegível nunca ordena como 'igual' a uma legível (fail-closed)", () => {
    expect(compareVersions("latest", "0.31.10")).toBe(-1);
    expect(compareVersions("0.31.10", "latest")).toBe(1);
    expect(compareVersions("latest", "latest")).toBe(0);
  });

  it("inRange é inclusivo e reprova entrada não verificável", () => {
    expect(inRange("0.31.0", "0.31.0", "0.31.99")).toBe(true);
    expect(inRange("0.31.99", "0.31.0", "0.31.99")).toBe(true);
    expect(inRange("0.30.99", "0.31.0", "0.31.99")).toBe(false);
    expect(inRange("0.32.0", "0.31.0", "0.31.99")).toBe(false);
    expect(inRange("0.18.1", "0.31.0", "0.31.99")).toBe(false);
    expect(inRange("0.31.10-rc.1", "0.31.0", "0.31.99")).toBe(true);
    expect(inRange("0.31.10", "latest", "0.31.99")).toBe(false);
  });
});
