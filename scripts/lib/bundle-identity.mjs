// Identidade de conteudo para o relatorio de bundle.
//
// O check:bundle media so bytes (minified/gzip/brotli): dois builds diferentes
// podem ter exatamente o mesmo tamanho e o relato "bundle identico" era mais
// fraco do que sugeria. Aqui cada artefato ganha sha256 do conteudo e o grafo
// inicial ganha um hash agregado sobre `arquivo:hash` ordenado — identidade de
// conteudo, nao de cardinalidade de bytes.

import { createHash } from "node:crypto";

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function aggregateSha256(entries) {
  const linhas = [...entries]
    .map(({ file, sha256: hash }) => {
      if (typeof file !== "string" || /[:\n]/.test(file)) {
        throw new Error(`nome de arquivo invalido para identidade: ${JSON.stringify(file)}`);
      }
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`sha256 invalido para ${file}`);
      }
      return { file, hash };
    })
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, hash }) => `${file}:${hash}`)
    .join("\n");
  return sha256(linhas);
}

export function identityOf(files) {
  const perFile = files
    .map(({ file, contents }) => ({ file, sha256: sha256(contents) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { files: perFile, graphSha256: aggregateSha256(perFile) };
}
