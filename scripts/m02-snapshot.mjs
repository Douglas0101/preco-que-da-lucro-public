// m02-snapshot.mjs — snapshot read-only de produção (rodada CUTOVER-PREP, P5;
// Emenda #4 à norma ENV-GUARD: sancionada SOMENTE como pg_dump read-only via
// DIRECT; NÃO relaxa o hard-deny de db:migrate contra produção).
// Emenda #6 (RAT S0, DP5=(b)): com --out-dir explícito, produz o trio
// dump.pgc + dump.pgc.sha256 + metadata.json (contrato N-6); sem --out-dir,
// preserva o layout padrão snapshot-<data>.dump (default inalterado).
//
// Contrato:
//   npm run m02:snapshot -- [--source-env <NOME_DA_ENV>] [--out-dir <dir>] [--origin <rotulo>]
//   - A URL de conexão vem SEMPRE da env indicada pelo NOME (nunca valor em
//     argv, nunca impressa — apenas host mascarado).
//   - Exige motivo da operação no ambiente do registro: ALLOW_REMOTE_DB=<motivo>
//     (mesma norma §5 da emenda; entra no metadata.json do artefato).
//   - Recusa endpoint POOLED (contém "-pooler" no host): dump é via DIRECT
//     (Plano Mestre §2.4/§12.2). Motivo e pooler valem NOS DOIS modos.
//   - Modo default (sem --out-dir): <out-dir>/snapshot-<data>.dump (+seq anti-
//     sobrescrita) + .sha256 root-relative + .metadata.json. INALTERADO.
//   - Modo explícito (--out-dir informado): trio exato dump.pgc /
//     dump.pgc.sha256 (`<sha>  dump.pgc`) / metadata.json com
//     {producer:"m02:snapshot", source, connection_kind:"direct",
//     read_only:true, motivo não-vazio, created_at UTC (=início da captura),
//     sha256, size_bytes, started_at/finished_at, versões pg, host mascarado}.
//     Se qualquer parte do trio pré-existir: exit 2 fail-closed, sem
//     sobrescrever (pré-conexão, prova anterior preservada).
//   - Mecanismo: pg_dump -Fc --no-owner --no-privileges do container local
//     postgres:17-alpine (binários ausentes no host); somente ACCESS SHARE —
//     nenhum DML/DDL é emitido.
//   - Sucesso (exit 0) SOMENTE pós-hash: arquivos de sucesso só após dump
//     concluído + hash calculado; saída parcial nunca equivale a válido.
// Exit codes: 0 ok · 3 alvo proibido (pooler/ausência de motivo, pré-conexão) · 2 fail-closed.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTAINER = "preco-que-da-lucro-postgres";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const REPOSITORY_ROOT = realpathSync(resolve(fileURLToPath(import.meta.url), "..", ".."));
const TEMP_ROOT = realpathSync(tmpdir());

/** Trio exato do modo explícito (Emenda #6, contrato N-6). */
const TRIO_FILENAMES = ["dump.pgc", "dump.pgc.sha256", "metadata.json"];

function usage() {
  return [
    "uso: npm run m02:snapshot -- [--source-env DATABASE_ADMIN_URL] [--out-dir artifacts/snapshots] [--origin production]",
    "Sem --out-dir: layout padrão snapshot-<data>.dump (inalterado).",
    "Com --out-dir explícito: trio dump.pgc + dump.pgc.sha256 + metadata.json; trio pré-existente = exit 2.",
    "Requer: env de conexão (nome em --source-env) e ALLOW_REMOTE_DB=<motivo> registrado.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    sourceEnv: "DATABASE_ADMIN_URL",
    outDir: "artifacts/snapshots",
    origin: "production",
    outDirExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      if (arg === `--${name}`) {
        index += 1;
        return argv[index];
      }
      return undefined;
    };
    const source = take("source-env");
    if (source !== undefined) {
      parsed.sourceEnv = source;
      continue;
    }
    const out = take("out-dir");
    if (out !== undefined) {
      parsed.outDir = out;
      parsed.outDirExplicit = true;
      continue;
    }
    const origin = take("origin");
    if (origin !== undefined) {
      parsed.origin = origin;
      continue;
    }
    return { error: `argumento não reconhecido: ${arg}` };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parsed.sourceEnv))
    return { error: "--source-env exige nome de env válido" };
  if (!/^[A-Za-z0-9._-]+$/.test(parsed.origin)) return { error: "--origin exige rótulo simples" };
  return parsed;
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Partes do trio já presentes no diretório (fail-closed: exige dir novo). */
function trioPreexists(outDir) {
  return TRIO_FILENAMES.filter((name) => existsSync(resolve(outDir, name)));
}

/** Metadata do trio, pura e testável (contrato N-6, Emenda #6 item 4). */
function buildTrioMetadata(input) {
  return {
    producer: "m02:snapshot",
    source: input.origin,
    connection_kind: "direct",
    read_only: true,
    motivo: input.motivo,
    created_at: input.startedAt,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    origin: input.origin,
    source_env: input.sourceEnv,
    host: input.host,
    direct: true,
    pg_dump_client: input.clientVersion,
    pg_server_version: input.serverVersion ?? null,
    pg_in_recovery: input.inRecovery ?? null,
    size_bytes: input.sizeBytes,
    duration_ms: input.durationMs,
    sha256: input.sha256,
    read_only_proof:
      "pg_dump -Fc toma apenas ACCESS SHARE; nenhum DML/DDL emitido; psql somente SHOW/pg_is_in_recovery (leitura); produção permaneceu como encontrada (suspensa/acorda para a leitura)",
  };
}

function runInContainer(command, args, env) {
  const result = spawnSync(
    "/usr/bin/docker",
    ["exec", "-i", "-e", "PGPASSWORD", "-e", "PGSSLMODE", CONTAINER, command, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 300_000,
    },
  );
  return result;
}

function stop(message, code) {
  process.stderr.write(message);
  process.exitCode = code;
  return null;
}

function readSnapshotTarget(parsed) {
  const motivo =
    typeof process.env.ALLOW_REMOTE_DB === "string" ? process.env.ALLOW_REMOTE_DB.trim() : "";
  if (motivo === "") {
    return stop(
      JSON.stringify({
        script: "m02:snapshot",
        result: "DENY-pre-conexao",
        reason: "motivo obrigatório via ALLOW_REMOTE_DB (Emenda #4; norma §5 da emenda ENV-GUARD)",
      }) + "\n",
      3,
    );
  }
  const rawUrl = process.env[parsed.sourceEnv];
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return stop(
      `m02-snapshot: env ${parsed.sourceEnv} ausente (fail-closed; valores nunca impressos)\n`,
      2,
    );
  }
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return stop("m02-snapshot: URL malformada (fail-closed; valor omitido)\n", 2);
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("-pooler")) {
    return stop(
      JSON.stringify({
        script: "m02:snapshot",
        result: "DENY-pre-conexao",
        reason: `dump exige DIRECT; host ${host} é pooled (recusado)`,
      }) + "\n",
      3,
    );
  }
  return { motivo, url, host, isLocal: LOCAL_HOSTNAMES.has(host) };
}

function isWithin(base, candidate) {
  const descendant = relative(base, candidate);
  return descendant === "" || (!descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function existingParent(candidate) {
  let lexical = candidate;
  while (!existsSync(lexical)) {
    const parent = resolve(lexical, "..");
    if (parent === lexical) throw new Error("diretório pai da saída não pode ser resolvido");
    lexical = parent;
  }
  return { lexical, real: realpathSync(lexical) };
}

function resolveSafeOutputDirectory(rootDir, raw) {
  const repositoryRoot = realpathSync(rootDir);
  const candidate = resolve(rootDir, raw);
  const allowedRoot = [repositoryRoot, TEMP_ROOT].find((root) => isWithin(root, candidate));
  if (!allowedRoot) {
    return stop("m02-snapshot: --out-dir fora das raízes permitidas; fail-closed\n", 2);
  }
  try {
    const parent = existingParent(candidate);
    if (!isWithin(allowedRoot, parent.real)) {
      return stop("m02-snapshot: pai de --out-dir usa symlink fora da raiz; fail-closed\n", 2);
    }
    const safeCandidate = resolve(parent.real, relative(parent.lexical, candidate));
    if (!isWithin(allowedRoot, safeCandidate)) {
      return stop("m02-snapshot: --out-dir fora da raiz permitida; fail-closed\n", 2);
    }
    if (existsSync(safeCandidate)) {
      const real = realpathSync(safeCandidate);
      if (real !== safeCandidate || !statSync(real).isDirectory()) {
        return stop("m02-snapshot: --out-dir não é diretório regular seguro; fail-closed\n", 2);
      }
    }
    return safeCandidate;
  } catch {
    return stop("m02-snapshot: --out-dir não pode ser resolvido com segurança; fail-closed\n", 2);
  }
}

function prepareOutput(rootDir, parsed) {
  const outDir = resolveSafeOutputDirectory(rootDir, parsed.outDir);
  if (outDir === null) return null;
  mkdirSync(outDir, { recursive: true });
  const realOutDir = realpathSync(outDir);
  if (realOutDir !== outDir) {
    return stop("m02-snapshot: --out-dir mudou para symlink durante a criação; fail-closed\n", 2);
  }
  if (parsed.outDirExplicit !== true) return outDir;
  const present = trioPreexists(outDir);
  if (present.length === 0) return outDir;
  return stop(
    `m02-snapshot: trio já existe em ${parsed.outDir} (${present.join(", ")}); use um diretório novo (fail-closed)\n`,
    2,
  );
}

function ensureContainer() {
  const probe = spawnSync("/usr/bin/docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], {
    encoding: "utf8",
  });
  if (probe.status === 0 && String(probe.stdout).trim() === "true") return true;
  stop(
    `m02-snapshot: container ${CONTAINER} indisponível para pg_dump 17 (fail-closed, nada conectado)\n`,
    2,
  );
  return false;
}

function chooseDumpName(outDir, parsed, startedAt) {
  if (parsed.outDirExplicit === true) return "dump.pgc";
  const date = startedAt.toISOString().slice(0, 10);
  let dumpName = `snapshot-${date}.dump`;
  for (let seq = 2; existsSync(resolve(outDir, dumpName)); seq += 1) {
    dumpName = `snapshot-${date}-${seq}.dump`;
  }
  return dumpName;
}

function prepareSnapshot(rootDir, parsed) {
  const target = readSnapshotTarget(parsed);
  if (target === null) return null;
  const outDir = prepareOutput(rootDir, parsed);
  if (outDir === null || !ensureContainer()) return null;
  const startedAt = new Date();
  const dumpName = chooseDumpName(outDir, parsed, startedAt);
  const dumpPath = resolve(outDir, dumpName);
  const inContainerPath = `/tmp/m02-snapshot-${Date.now()}.pgc`;
  const pgDumpVersion = runInContainer("pg_dump", ["--version"], {});
  const psqlVersion = runInContainer("psql", ["--version"], {});
  if (pgDumpVersion.status !== 0 || psqlVersion.status !== 0) {
    stop("m02-snapshot: binários pg_dump ausentes no container (fail-closed)\n", 2);
    return null;
  }
  const clientVersion = String(pgDumpVersion.stdout).split("\n")[0].trim();
  return {
    parsed,
    target,
    outDir,
    startedAt,
    dumpName,
    dumpPath,
    inContainerPath,
    clientVersion,
  };
}

function captureSnapshot(context) {
  const { parsed, target, dumpPath, inContainerPath } = context;
  const { url, host, isLocal, motivo } = target;
  process.stdout.write(
    `${JSON.stringify({ script: "m02:snapshot", event: "start", mode: parsed.outDirExplicit ? "trio" : "default", origin: parsed.origin, host, source_env: parsed.sourceEnv, direct: true, motivo })}\n`,
  );
  const database = decodeURIComponent(url.pathname.replace(/^\//, "") || "neondb");
  const user = decodeURIComponent(url.username || "neondb_owner");
  const port = url.port || "5432";
  const sslmode = isLocal ? "disable" : "require";
  const connectionArgs = [
    "--host",
    url.hostname,
    "--port",
    port,
    "--dbname",
    database,
    "--username",
    user,
  ];
  const connectionEnv = {
    PGPASSWORD: url.password ? decodeURIComponent(url.password) : "",
    PGSSLMODE: sslmode,
  };
  try {
    const dump = runInContainer(
      "pg_dump",
      [...connectionArgs, "-Fc", "--no-owner", "--no-privileges", "-f", inContainerPath],
      connectionEnv,
    );
    if (dump.status !== 0) {
      const safe = String(dump.stderr || dump.stdout || "").includes("@")
        ? "falha no dump (detalhes omitidos — possível credencial na saída)"
        : String(dump.stderr || "").slice(0, 240);
      stop(`m02-snapshot: dump falhou (fail-closed; nada escrito no repo): ${safe}\n`, 2);
      return null;
    }
    const serverVersionResult = runInContainer(
      "psql",
      [...connectionArgs, "-tAc", "show server_version"],
      connectionEnv,
    );
    const recoveryResult = runInContainer(
      "psql",
      [...connectionArgs, "-tAc", "select pg_is_in_recovery()"],
      connectionEnv,
    );
    if (serverVersionResult.status !== 0 || recoveryResult.status !== 0) {
      stop("m02-snapshot: leitura de metadados falhou (fail-closed; nada escrito no repo)\n", 2);
      return null;
    }
    const serverVersion = String(serverVersionResult.stdout).trim();
    const inRecovery = String(recoveryResult.stdout).trim();
    try {
      execFileSync("/usr/bin/docker", ["cp", `${CONTAINER}:${inContainerPath}`, dumpPath], {
        stdio: "ignore",
      });
    } catch {
      stop("m02-snapshot: docker cp falhou (fail-closed)\n", 2);
      return null;
    }
    return { serverVersion, inRecovery };
  } finally {
    runInContainer("rm", ["-f", inContainerPath], {});
  }
}

function writeSnapshotArtifacts(rootDir, context, capture) {
  const { parsed, target, outDir, startedAt, dumpName, dumpPath, clientVersion } = context;
  const { host, motivo } = target;
  const { serverVersion, inRecovery } = capture;
  const finishedAt = new Date();
  const sizeBytes = statSync(dumpPath).size;
  const sha256 = sha256OfFile(dumpPath);
  const rootRelativeDump = relative(rootDir, dumpPath);
  if (parsed.outDirExplicit === true) {
    writeFileSync(resolve(outDir, "dump.pgc.sha256"), `${sha256}  dump.pgc\n`, "utf8");
    const metadata = buildTrioMetadata({
      origin: parsed.origin,
      sourceEnv: parsed.sourceEnv,
      host,
      clientVersion,
      serverVersion,
      inRecovery,
      sizeBytes,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      sha256,
      motivo,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });
    writeFileSync(
      resolve(outDir, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
  } else {
    writeFileSync(
      resolve(outDir, `${dumpName}.sha256`),
      `${sha256}  ${rootRelativeDump}\n`,
      "utf8",
    );
    const metadata = {
      script: "m02:snapshot",
      origin: parsed.origin,
      source_env: parsed.sourceEnv,
      host,
      direct: true,
      pg_dump_client: clientVersion,
      pg_server_version: serverVersion ?? null,
      pg_in_recovery: inRecovery ?? null,
      size_bytes: sizeBytes,
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      sha256,
      motivo,
      read_only: true,
      read_only_proof:
        "pg_dump -Fc toma apenas ACCESS SHARE; nenhum DML/DDL emitido; psql somente SHOW/pg_is_in_recovery (leitura); produção permaneceu como encontrada (suspensa/acorda para a leitura)",
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
    };
    const metadataPath = resolve(outDir, dumpName.replace(/\.dump$/, ".metadata.json"));
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  return { finishedAt, sizeBytes, sha256, rootRelativeDump, serverVersion };
}

function main() {
  const rootDir = resolve(fileURLToPath(import.meta.url), "..", "..");
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`m02-snapshot: ${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const context = prepareSnapshot(rootDir, parsed);
  if (context === null) return;
  const capture = captureSnapshot(context);
  if (capture === null) return;
  const result = writeSnapshotArtifacts(rootDir, context, capture);
  process.stdout.write(
    `${JSON.stringify({ script: "m02:snapshot", event: "done", mode: parsed.outDirExplicit ? "trio" : "default", dump: result.rootRelativeDump, size_bytes: result.sizeBytes, sha256: result.sha256, duration_ms: result.finishedAt.getTime() - context.startedAt.getTime(), server_version: result.serverVersion ?? null })}\n`,
  );
  process.exitCode = 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseArgs, sha256OfFile, TRIO_FILENAMES, trioPreexists, buildTrioMetadata };
