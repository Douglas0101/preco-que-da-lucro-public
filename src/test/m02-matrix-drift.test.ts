import { describe, expect, it } from "vitest";
import { describeMatrixDrift } from "../../scripts/lib/m02-matrix-drift";
import type { MatrixArtifact } from "../../scripts/lib/m02-matrix-drift";

const LABEL = "docs/specs/M-02/matrix.generated.yaml";

const COUNTS = {
  bffModules: 8,
  createServerFnDeclarations: 35,
  concreteOperations: 36,
  apiRoutes: 5,
  transactionSites: 113,
  directDatabaseFiles: 49,
};

/** Documento como a árvore o produz, ou como está commitado — o mesmo formato. */
function document(patch: Record<string, unknown> = {}): string {
  const { counts, ...rest } = patch;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      counts: { ...COUNTS, ...((counts ?? {}) as Record<string, number>) },
      bffs: [],
      routes: [],
      transactionSites: [],
      directDatabaseFiles: [],
      ...rest,
    },
    null,
    2,
  )}\n`;
}

function artifact(fromTree: string, onDisk: string | null, label = LABEL): MatrixArtifact {
  return { label, fromTree, onDisk };
}

describe("descritor de deriva da matriz M-02", () => {
  it("não explica nada quando a árvore está em dia", () => {
    const same = document();
    expect(describeMatrixDrift([artifact(same, same)])).toEqual([]);
  });

  it("responde na direção que o leitor pergunta: o que a árvore mudou, não o contrário", () => {
    // Cenário real medido no WP2: uma sonda nova em `src/lib/` move `bffModules`
    // de 8 para 9 e entra na lista de `bffs`. O leitor precisa ler "+ sonda" e
    // "8 -> 9". A primeira versão deste módulo dizia "9 -> 8" e "- sonda",
    // porque chamava a árvore de `expected` e o arquivo de `actual`.
    const onDisk = document();
    const fromTree = document({
      counts: { bffModules: 9 },
      bffs: [{ path: "src/lib/zzz-wp2-probe.functions.ts", kind: "server-fn" }],
    });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain("    counts.bffModules: 8 -> 9");
    expect(lines).toContain("    bffs: 0 -> 1 (1 added, 0 removed)");
    expect(lines).toContain("      + src/lib/zzz-wp2-probe.functions.ts");
    expect(lines.join("\n")).not.toContain("9 -> 8");
    expect(lines.join("\n")).not.toContain("- src/lib/zzz-wp2-probe.functions.ts");
  });

  it("e um arquivo removido da árvore aparece como removido", () => {
    const onDisk = document({
      counts: { bffModules: 9 },
      bffs: [{ path: "src/lib/antigo.functions.ts", kind: "server-fn" }],
    });
    const fromTree = document();
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain("    counts.bffModules: 9 -> 8");
    expect(lines).toContain("    bffs: 1 -> 0 (0 added, 1 removed)");
    expect(lines).toContain("      - src/lib/antigo.functions.ts");
  });

  it("nomeia o contador que mudou — e só ele", () => {
    const onDisk = document();
    const fromTree = document({ counts: { transactionSites: 115 } });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain(`  ${LABEL}:`);
    expect(lines).toContain("    counts.transactionSites: 113 -> 115");
    // Nenhum outro contador pode aparecer: a mensagem existe para nomear UM.
    expect(lines.join("\n")).not.toContain("counts.bffModules");
    expect(lines.join("\n")).not.toContain("counts.apiRoutes");
  });

  it("nomeia cada lista que mudou, com as entradas que entraram e as que saíram", () => {
    const onDisk = document({
      directDatabaseFiles: ["src/db/a.ts"],
      transactionSites: [{ path: "src/lib/a.ts", line: 10 }],
    });
    const fromTree = document({
      directDatabaseFiles: ["src/db/a.ts", "src/test/novo.test.ts"],
      transactionSites: [
        { path: "src/lib/a.ts", line: 10 },
        { path: "src/lib/b.ts", line: 3 },
      ],
    });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain("    directDatabaseFiles: 1 -> 2 (1 added, 0 removed)");
    expect(lines).toContain("      + src/test/novo.test.ts");
    expect(lines).toContain("    transactionSites: 1 -> 2 (1 added, 0 removed)");
    expect(lines).toContain("      + src/lib/b.ts:3");
    // Lista mudou, contadores não: nenhuma linha de contador pode aparecer.
    expect(lines.join("\n")).not.toContain("counts.");
  });

  it("distingue o que saiu do que entrou, contando repetições", () => {
    const onDisk = document({ directDatabaseFiles: ["src/db/a.ts", "src/db/a.ts"] });
    const fromTree = document({ directDatabaseFiles: ["src/db/a.ts"] });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain("    directDatabaseFiles: 2 -> 1 (0 added, 1 removed)");
    expect(lines).toContain("      - src/db/a.ts");
  });

  it("diz que só o overlay divergiu quando contadores e listas estão iguais", () => {
    const onDisk = document({ policy: { status: "DRAFT" } });
    const fromTree = document({ policy: { status: "FROZEN" } });

    expect(describeMatrixDrift([artifact(fromTree, onDisk)])).toEqual([
      `  ${LABEL}:`,
      "    only the policy overlay differs (counts and lists are identical)",
    ]);
  });

  it("distingue arquivo ausente de arquivo ilegível — e nenhum dos dois é 'drift'", () => {
    const fromTree = document();

    expect(describeMatrixDrift([artifact(fromTree, null)])).toEqual([
      `  ${LABEL}: missing (the file does not exist)`,
    ]);
    expect(describeMatrixDrift([artifact(fromTree, "{ nao e json")])).toEqual([
      `  ${LABEL}: unreadable (invalid JSON, or not an object)`,
    ]);
    expect(describeMatrixDrift([artifact(fromTree, "[1, 2, 3]")])).toEqual([
      `  ${LABEL}: unreadable (invalid JSON, or not an object)`,
    ]);
  });

  it("não culpa o overlay quando o que mudou está dentro de uma lista", () => {
    // N1 do veredicto adversarial: acrescentar um import não-DB a um
    // `*.functions.ts` existente muda `bffs[].imports` — não move contador nenhum
    // e não muda a identidade da entrada (que é o `path`). A primeira versão
    // dizia `only the policy overlay differs` para isso, que é FALSO.
    const onDisk = document({
      bffs: [{ path: "src/lib/a.functions.ts", imports: ["@/db"] }],
    });
    const fromTree = document({
      bffs: [{ path: "src/lib/a.functions.ts", imports: ["@/db", "./helper"] }],
    });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain(
      "    the counters and the list identities are identical, but the content of bffs differs",
    );
    expect(lines.join("\n")).not.toContain("only the policy overlay differs");
  });

  it("nomeia campo desconhecido em vez de culpar a política", () => {
    const onDisk = document();
    const fromTree = document({ schemaVersion: 2 });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain(
      "    the counters and the list identities are identical, but these fields differ: schemaVersion",
    );
    expect(lines.join("\n")).not.toContain("only the policy overlay differs");
  });

  it("diz em qual dos dois arquivos a deriva está — e nomeia só ele", () => {
    // O artefato em dia entra na lista de propósito: sem ele o caso não testa
    // "só o que derivou é nomeado", que é a propriedade que a SPEC lhe atribui.
    const emDia = document();
    const onDisk = document();
    const fromTree = document({ counts: { bffModules: 9 } });
    const lines = describeMatrixDrift([
      artifact(emDia, emDia, "matrix.generated.yaml"),
      artifact(fromTree, onDisk, "matrix.yaml"),
    ]);

    expect(lines).toContain("  matrix.yaml:");
    expect(lines).toContain("    counts.bffModules: 8 -> 9");
    expect(lines).not.toContain("  matrix.generated.yaml:");
  });

  it("trunca a lista no teto e declara o total, em vez de despejar o arquivo", () => {
    const onDisk = document({ directDatabaseFiles: [] });
    const many = Array.from({ length: 20 }, (_, index) => `src/db/arquivo-${index}.ts`);
    const fromTree = document({ directDatabaseFiles: many });
    const lines = describeMatrixDrift([artifact(fromTree, onDisk)]);

    expect(lines).toContain("    directDatabaseFiles: 0 -> 20 (20 added, 0 removed)");
    expect(lines.filter((line) => line.startsWith("      + "))).toHaveLength(8);
    expect(lines).toContain("      ... and 12 more of 20");
  });
});
