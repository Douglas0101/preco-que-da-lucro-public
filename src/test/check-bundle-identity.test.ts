import { describe, expect, it } from "vitest";
import { aggregateSha256, identityOf, sha256 } from "../../scripts/lib/bundle-identity.mjs";

describe("identidade de conteúdo do bundle", () => {
  it("mesmo tamanho com conteúdos diferentes NÃO é identidade (RED do bundle)", () => {
    const a = "AAAA";
    const b = "BBBB";
    expect(a.length).toBe(b.length);
    expect(sha256(a)).not.toBe(sha256(b));
  });

  it("mesmo conteúdo dá o mesmo hash, em qualquer ordem", () => {
    const ids = identityOf([
      { file: "b.js", contents: "BBBB" },
      { file: "a.js", contents: "AAAA" },
    ]);
    expect(ids.files.map((f) => f.file)).toEqual(["a.js", "b.js"]);
    expect(ids.graphSha256).toBe(
      identityOf([
        { file: "a.js", contents: "AAAA" },
        { file: "b.js", contents: "BBBB" },
      ]).graphSha256,
    );
  });

  it("uma mudança de conteúdo move o hash do grafo", () => {
    const antes = aggregateSha256([
      { file: "a.js", sha256: sha256("AAAA") },
      { file: "b.js", sha256: sha256("BBBB") },
    ]);
    const depois = aggregateSha256([
      { file: "a.js", sha256: sha256("AAAA") },
      { file: "b.js", sha256: sha256("BBBC") },
    ]);
    expect(depois).not.toBe(antes);
  });

  it("renomear um arquivo também move o hash agregado (identidade inclui o nome)", () => {
    const hash = sha256("AAAA");
    expect(aggregateSha256([{ file: "a.js", sha256: hash }])).not.toBe(
      aggregateSha256([{ file: "c.js", sha256: hash }]),
    );
  });

  it("nome com ':' ou quebra de linha lança (sem colisão silenciosa no agregado)", () => {
    const hash = sha256("AAAA");
    expect(() => aggregateSha256([{ file: "a:b", sha256: hash }])).toThrow();
    expect(() => aggregateSha256([{ file: "a\nb", sha256: hash }])).toThrow();
  });
});
