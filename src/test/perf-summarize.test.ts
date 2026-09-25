import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  percentile,
  renderReport,
  summarize,
  summarizeDir,
  type PerfRaw,
} from "../../scripts/perf/summarize.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts/perf/summarize.mjs");
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "perf-summarize-"));
  tempDirs.push(dir);
  return dir;
}

function fixtureRaw(): PerfRaw {
  return {
    meta: {
      label: "CONTROLADO",
      commit: "abc1234",
      startedAt: "2026-09-13T10:00:00.000Z",
      finishedAt: "2026-09-13T10:10:00.000Z",
      iterations: 3,
      warmupIterations: 1,
      baseUrl: "http://127.0.0.1:4219",
      gaps: ["gateway real de IA não medido"],
    },
    routeSamples: [
      {
        kind: "route",
        route: "/inicio",
        iteration: 1,
        warmup: false,
        status: 200,
        readyMs: 100,
        ttfbMs: 10,
        lcpMs: 200,
        cls: 0.01,
        fcpMs: 50,
        loadMs: 150,
        serverFn: [{ path: "/_serverFn/a", durationMs: 30 }],
      },
      {
        kind: "route",
        route: "/inicio",
        iteration: 2,
        warmup: false,
        status: 200,
        readyMs: 120,
        ttfbMs: 12,
        lcpMs: 220,
        cls: 0.02,
        fcpMs: 60,
        loadMs: 160,
        serverFn: [{ path: "/_serverFn/a", durationMs: 40 }],
      },
      {
        kind: "route",
        route: "/inicio",
        iteration: 3,
        warmup: false,
        status: 200,
        readyMs: 140,
        ttfbMs: 14,
        lcpMs: 240,
        cls: 0.03,
        fcpMs: 70,
        loadMs: 170,
        serverFn: [{ path: "/_serverFn/a", durationMs: 50 }],
      },
      {
        kind: "route",
        route: "/inicio",
        iteration: 0,
        warmup: true,
        status: 200,
        readyMs: 999,
        ttfbMs: 999,
        lcpMs: 999,
        cls: 0.9,
        fcpMs: 999,
        loadMs: 999,
        serverFn: [],
      },
      {
        kind: "route",
        route: "/produtos",
        iteration: 1,
        warmup: false,
        status: 200,
        readyMs: 200,
        ttfbMs: 20,
        lcpMs: 300,
        cls: 0.04,
        fcpMs: 80,
        loadMs: 250,
        serverFn: [{ path: "/_serverFn/b", durationMs: 70 }],
      },
      {
        kind: "route",
        route: "/produtos",
        iteration: 2,
        warmup: false,
        status: 200,
        readyMs: 220,
        ttfbMs: 22,
        lcpMs: 320,
        cls: 0.05,
        fcpMs: 90,
        loadMs: 260,
        serverFn: [{ path: "/_serverFn/b", durationMs: 80 }],
      },
      {
        kind: "route",
        route: "/produtos",
        iteration: 3,
        warmup: false,
        status: 200,
        readyMs: 240,
        ttfbMs: 24,
        lcpMs: 340,
        cls: 0.06,
        fcpMs: 100,
        loadMs: 270,
        serverFn: [{ path: "/_serverFn/b", durationMs: 90 }],
      },
    ],
    chatSamples: [
      { kind: "chat", iteration: 1, warmup: false, status: 200, sendMs: 120 },
      { kind: "chat", iteration: 2, warmup: false, status: 200, sendMs: 130 },
      { kind: "chat", iteration: 3, warmup: false, status: 200, sendMs: 140 },
    ],
    contextTx: [
      {
        kind: "context_tx",
        phase: "route:/inicio",
        warmup: false,
        round_trips: 3,
        duration_ms: 2,
        outcome: "commit",
      },
      {
        kind: "context_tx",
        phase: "route:/inicio",
        warmup: false,
        round_trips: 4,
        duration_ms: 4,
        outcome: "commit",
      },
      {
        kind: "context_tx",
        phase: "route:/inicio",
        warmup: false,
        round_trips: 5,
        duration_ms: 6,
        outcome: "commit",
      },
      {
        kind: "context_tx",
        phase: "route:/produtos",
        warmup: false,
        round_trips: 7,
        duration_ms: 8,
        outcome: "commit",
      },
    ],
    aiAttempts: [
      {
        kind: "ai.model_attempt",
        phase: "chat:1",
        warmup: false,
        model: "mock/model",
        attempt: 1,
        durationMs: 40,
        outcome: "success",
      },
      {
        kind: "ai.model_attempt",
        phase: "chat:2",
        warmup: false,
        model: "mock/model",
        attempt: 1,
        durationMs: 50,
        outcome: "success",
      },
      {
        kind: "ai.model_attempt",
        phase: "chat:3",
        warmup: false,
        model: "mock/model",
        attempt: 1,
        durationMs: 60,
        outcome: "success",
      },
    ],
    bundleReport: {
      budget: { entryMinifiedBytes: 500_000, initialGraphMinifiedBytes: 500_000 },
      entries: [
        {
          file: "assets/app-abc.js",
          minifiedBytes: 100_000,
          gzipBytes: 30_000,
          brotliBytes: 25_000,
          passed: true,
          initialGraph: {
            files: ["assets/app-abc.js"],
            minifiedBytes: 120_000,
            gzipBytes: 35_000,
            brotliBytes: 30_000,
            limitBytes: 500_000,
          },
        },
      ],
    },
  };
}

async function writeFixture(dir: string, raw: PerfRaw): Promise<void> {
  const lines = (items: Array<Record<string, unknown>> | undefined) =>
    `${(items ?? []).map((item) => JSON.stringify(item)).join("\n")}\n`;
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(raw.meta ?? {}, null, 2));
  await writeFile(path.join(dir, "route-samples.jsonl"), lines(raw.routeSamples));
  await writeFile(path.join(dir, "chat-samples.jsonl"), lines(raw.chatSamples));
  await writeFile(path.join(dir, "context-tx.jsonl"), lines(raw.contextTx));
  await writeFile(path.join(dir, "ai-model-attempts.jsonl"), lines(raw.aiAttempts));
  await writeFile(
    path.join(dir, "bundle-report.json"),
    JSON.stringify(raw.bundleReport ?? {}, null, 2),
  );
}

describe("percentile (interpolação linear R-7)", () => {
  it("interpola entre ranks", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
    expect(percentile([10, 20, 30, 40], 95)).toBe(38.5);
  });

  it("lida com vazio, unitário e valores inválidos", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([Number.NaN, 10, Number.POSITIVE_INFINITY], 50)).toBe(10);
  });
});

describe("summarize com fixture sintético", () => {
  it("agrega rotas, queries, IA e bundle e declara lacunas", () => {
    const report = summarize(fixtureRaw());
    const inicio = report.routes.find((route) => route.route === "/inicio");
    expect(inicio?.samples).toBe(3);
    expect(inicio?.ready.p50).toBe(120);
    expect(inicio?.ready.p95).toBe(138);
    expect(inicio?.ttfb.p50).toBe(12);
    expect(inicio?.serverFn.p50).toBe(40);
    expect(inicio?.lcp.p50).toBe(220);

    const produtos = report.routes.find((route) => route.route === "/produtos");
    expect(produtos?.ready.p50).toBe(220);
    expect(produtos?.serverFn.p50).toBe(80);

    const queryInicio = report.query.find((row) => row.route === "/inicio");
    expect(queryInicio?.events).toBe(3);
    expect(queryInicio?.roundTrips).toBe(12);
    expect(queryInicio?.duration.p50).toBe(4);

    expect(report.ai.latency.n).toBe(3);
    expect(report.ai.latency.p50).toBe(50);
    expect(report.ai.latency.p95).toBe(59);
    expect(report.ai.bySource).toEqual({ "chat-http": 3 });
    expect(report.chat.send.p50).toBe(130);

    expect(report.bundle?.entries[0]?.minifiedBytes).toBe(100_000);
    expect(report.bundle?.entries[0]?.passed).toBe(true);

    expect(report.gaps).toContain("gateway real de IA não medido");
    expect(report.gaps).not.toContain("Nenhuma amostra de rota medida (Playwright indisponível?).");
  });

  it("avisa quando a IA veio só do probe direto (chat HTTP indisponível)", () => {
    const raw = fixtureRaw();
    for (const attempt of raw.aiAttempts ?? []) attempt.phase = "ai:direct";
    const markdown = renderReport(summarize(raw));
    expect(markdown).toContain("sonda direta da camada de modelo");
  });

  it("renderiza os 8 itens de §5, método e limitações", () => {
    const markdown = renderReport(summarize(fixtureRaw()));
    expect(markdown).toContain("# Baseline de performance CONTROLADO");
    expect(markdown).toContain("1. p50/p95 de rotas internas");
    expect(markdown).toContain("2. Query count por tela");
    expect(markdown).toContain("3. Query duration");
    expect(markdown).toContain("4. Tempo de carregamento do dashboard");
    expect(markdown).toContain("5. Tempo de lista de produtos");
    expect(markdown).toContain("6. AI latency");
    expect(markdown).toContain("7. Tamanho de bundle");
    expect(markdown).toContain("8. Core Web Vitals em ambiente controlado");
    expect(markdown).toContain("`/inicio`");
    expect(markdown).toContain("## Decisões");
    expect(markdown).toContain("Mock de IA ≠ gateway real");
    expect(markdown).toContain("Local ≠ Neon");
    expect(markdown).toContain("interpolação linear R-7");
  });

  it("summarizeDir lê o raw e grava report.md", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, fixtureRaw());
    const { reportPath, report } = await summarizeDir(dir);
    expect(path.basename(reportPath)).toBe("report.md");
    expect(report.routes).toHaveLength(2);
    const markdown = await readFile(reportPath, "utf8");
    expect(markdown).toContain("# Baseline de performance CONTROLADO");
  });

  it("CLI com fixture termina com exit 0 e grava o relatório", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, fixtureRaw());
    const result = spawnSync(process.execPath, [script, "--dir", dir], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("report.md gerado");
  });

  it("declara lacuna quando o raw está vazio", async () => {
    const dir = await makeTempDir();
    const { report } = await summarizeDir(dir);
    expect(report.routes).toHaveLength(0);
    expect(report.gaps.length).toBeGreaterThan(0);
  });
});

/**
 * §35 — o gerador de evidência de performance NÃO pode apagar o contrato.
 *
 * O gate (`src/test/perf-evidence.test.ts`) descobre por CAMINHO todo `.md` de
 * `docs/evidence/perf-<tema>-<data>/` — o `report.md` gerado por
 * `scripts/perf/summarize.mjs` inclusive — e exige os 7 rótulos, com descoberta
 * vazia reprovando. Aqui o predicado do gate é replicado: rótulo presente e com
 * valor não vazio.
 */
const SECTION35_LABELS = [
  "hypothesis",
  "metric",
  "before",
  "change",
  "after",
  "result",
  "decision",
] as const;

const SECTION35_PATTERNS = SECTION35_LABELS.map((label) => ({
  label,
  // mesma forma do gate: `**rótulo:**` no início de uma linha, com valor não vazio
  pattern: new RegExp(`^\\s*(?:[-*]\\s*)?\\*\\*${label}\\s*:\\*\\*\\s*(\\S.*)$`, "im"),
}));

/** Recorta a seção `## §35` do markdown gerado (até o próximo título `## `). */
function section35Block(markdown: string): string {
  const start = markdown.indexOf("## §35");
  expect(start, "o report gerado não tem a seção `## §35`").toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

function missingSection35Labels(block: string): string[] {
  return SECTION35_PATTERNS.filter(({ pattern }) => !pattern.test(block)).map(({ label }) => label);
}

function section35Line(block: string, label: (typeof SECTION35_LABELS)[number]): string {
  const pattern = new RegExp(`\\*\\*${label}\\s*:\\*\\*`);
  const line = block.split("\n").find((candidate) => pattern.test(candidate));
  expect(line, `rótulo \`${label}\` ausente no bloco §35`).toBeDefined();
  return line ?? "";
}

describe("§35 — o report gerado carrega os rótulos do contrato", () => {
  it("T1: o bloco §35 traz os 7 rótulos, todos com valor", () => {
    const block = section35Block(renderReport(summarize(fixtureRaw())));
    expect(missingSection35Labels(block)).toEqual([]);
  });

  it("T1b: nada é inventado — os valores do bloco seguem o raw", () => {
    const original = section35Block(renderReport(summarize(fixtureRaw())));
    expect(original).toContain("CONTROLADO"); // regime
    expect(original).toContain("abc1234"); // commit de origem
    expect(original).toContain("2026-09-13T10:00:00.000Z"); // janela
    expect(original).toContain("n=3"); // amostras medidas por rota
    expect(original).toContain("`/inicio`");
    expect(original).toContain("120.0"); // prontidão p50 derivada do raw

    // dobra a prontidão medida no raw: o bloco tem de acompanhar
    const scaled = fixtureRaw();
    for (const sample of scaled.routeSamples ?? []) {
      if (sample.route === "/inicio" && sample.warmup === false) {
        sample.readyMs = Number(sample.readyMs) * 2;
      }
    }
    const after = section35Block(renderReport(summarize(scaled)));
    expect(original).not.toContain("240.0");
    expect(after).toContain("240.0");
    expect(after).toContain("276.0"); // p95 também derivado
  });

  it("T1c: rótulos de julgamento podem vir declarados no raw (`meta.section35`)", () => {
    const raw = fixtureRaw();
    raw.meta = {
      ...raw.meta,
      section35: {
        decision: "keep — decisão declarada pelo operador no raw",
        before: "p50 100 ms (n=5, captura anterior declarada no raw)",
      },
    };
    const block = section35Block(renderReport(summarize(raw)));
    expect(missingSection35Labels(block)).toEqual([]);
    expect(block).toContain("keep — decisão declarada pelo operador no raw");
    expect(block).toContain("p50 100 ms (n=5, captura anterior declarada no raw)");
    expect(block).toContain("abc1234"); // os derivados seguem derivados
  });

  it("T1d: a decisão derivada é conservadora — métrica primária ausente ⇒ `follow-up`, captura medida ⇒ `keep`", () => {
    const measured = section35Block(renderReport(summarize(fixtureRaw())));
    expect(section35Line(measured, "decision")).toContain("`keep`");
    expect(section35Line(measured, "decision")).not.toContain("follow-up");

    // sem amostra de rota não há métrica primária: não há referência a adotar
    const empty = fixtureRaw();
    empty.routeSamples = [];
    const emptyBlock = section35Block(renderReport(summarize(empty)));
    expect(section35Line(emptyBlock, "decision")).toContain("`follow-up`");
    expect(section35Line(emptyBlock, "decision")).not.toContain("`keep`");
  });

  it("T1e: o `report.md` gravado por summarizeDir carrega o bloco (é o arquivo que o gate varre)", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, fixtureRaw());
    const { reportPath } = await summarizeDir(dir);
    const markdown = await readFile(reportPath, "utf8");
    expect(section35Block(markdown)).toContain("- **hypothesis:**");
    expect(missingSection35Labels(section35Block(markdown))).toEqual([]);
  });

  it("T1f: par antes/depois declarado no raw não é contradito pelo `result`/`decision` derivados", () => {
    const raw = fixtureRaw();
    raw.meta = {
      ...raw.meta,
      section35: {
        before:
          "p50 3000 ms (n=5, captura 2026-09-10, fonte `docs/evidence/perf-baseline-2026-09-10.md`)",
        change: "`src/lib/products.functions.ts` (patch do read-model)",
      },
    };
    const block = section35Block(renderReport(summarize(raw)));
    expect(section35Line(block, "before")).toContain("p50 3000 ms");
    expect(section35Line(block, "change")).toContain("patch do read-model");
    // o gerador não calcula ganho: não pode afirmar que NÃO existe par antes/depois
    expect(section35Line(block, "result")).not.toContain("sem alegação de ganho");
    expect(section35Line(block, "result")).toContain(
      "o raw declara `before` e `change` em `meta.section35`",
    );
    // com rótulo de comparação declarado, `keep` exigiria julgamento: a decisão derivada pede revisão
    expect(section35Line(block, "decision")).toMatch(/\*\*decision:\*\* `follow-up`/);

    // sem rótulo declarado, o bloco segue sem alegação de ganho e com a referência adotada
    const plain = section35Block(renderReport(summarize(fixtureRaw())));
    expect(section35Line(plain, "result")).toContain("sem alegação de ganho");
    expect(section35Line(plain, "decision")).toMatch(/\*\*decision:\*\* `keep`/);
  });

  it("T1g: `change` declarado sozinho não vira «par declarado» — o texto cita só o rótulo que existe", () => {
    const raw = fixtureRaw();
    raw.meta = {
      ...raw.meta,
      section35: { change: "`src/lib/products.functions.ts` (patch do read-model)" },
    };
    const block = section35Block(renderReport(summarize(raw)));
    // o `before` continua sendo lacuna declarada — e o `result` não pode afirmar um par
    expect(section35Line(block, "before")).toMatch(/\*\*before:\*\* `N\/A`/);
    expect(section35Line(block, "result")).toContain("o raw declara `change` em `meta.section35`");
    expect(section35Line(block, "result")).not.toContain("par antes/depois");
    expect(section35Line(block, "result")).not.toContain("sem alegação de ganho");
    // a decisão segue pedindo o julgamento do autor (o ganho não é calculado aqui)
    expect(section35Line(block, "decision")).toMatch(/\*\*decision:\*\* `follow-up`/);
    expect(section35Line(block, "decision")).toContain("`change` em `meta.section35`");
  });
});
