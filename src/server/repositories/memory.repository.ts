/**
 * §43/§15.2/§15.4/§15.6 — persistência da memória (degraus D2 e D3).
 *
 * Implementa `MemoryRepositoryPort` com `Executor = context.transaction` por
 * padrão, no mesmo formato de `outbox.repository.ts`: a memória entra na
 * transação corrente, então um rollback do efeito de domínio não deixa memória
 * órfã (e vice-versa). A decisão B do STEWARD vale aqui — o append **não**
 * escreve evento no outbox: hoje não há consumidor de eventos de memória.
 *
 * Toda leitura e escrita carrega o predicado explícito de `tenant_id` **e** o
 * `user_id` do contexto; a RLS `tenant_isolation` é a segunda barreira
 * (fail-closed), não a primeira (§15.8). Nenhum SQL é montado por concatenação
 * (INV-003): o filtro textual é um `position(...)` parametrizado, e a
 * representação lexical (FTS/GIN) é D5.
 *
 * A proveniência é 1:N em `ai_memory_sources` (decisão C): o append grava uma
 * linha por origem declarada e o read model reconstrói a `MemoryProvenance` da
 * fonte mais antiga. Quando o produtor não gravou o rótulo opaco (`source_ref`
 * nulo), o `sourceId` derivado é o id da própria linha de fonte — identificador
 * durável e verificável, em vez de string sintética.
 *
 * D3 acrescenta três coisas, todas **dentro** da transação do chamador:
 * dedup determinístico (`dedup_key` + índice único parcial, SD-C3-1/2/10),
 * histórico append-only de versões (SD-C3-3/4) e registro explícito de conflito
 * (SD-C3-5/6). Nenhum `UPDATE`/`DELETE` é emitido contra `ai_memory_versions` —
 * a imutabilidade do histórico é do privilégio do banco, não do código.
 *
 * D4 fecha o §43: `export` (portabilidade com versões e fontes), `expireDue`
 * (TTL por camada, lido de `ai_memory_policies` — nunca de constante), delete
 * **físico** com autorização por escopo e a trilha `ai_memory_access_log`
 * gravada na MESMA transação de cada acesso, delete e export. O log não tem FK
 * para `ai_memories`: a trilha sobrevive ao delete que ela audita.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import {
  aiMemories,
  aiMemoryAccessLog,
  aiMemoryConflicts,
  aiMemoryPolicies,
  aiMemorySources,
  aiMemoryVersions,
} from "@/db/schema";
import { ApplicationError } from "@/lib/api-error";
import type { RequestContext } from "@/lib/request-context";
import type { Executor } from "@/server/contracts/event.contracts";
import type {
  MemoryAccessAction,
  MemoryAccessLogEntry,
  MemoryAccessLogFilter,
  MemoryAccessResult,
  MemoryAppendResult,
  MemoryCandidate,
  MemoryConflictFilter,
  MemoryConflictRecord,
  MemoryConflictStatus,
  MemoryDeleteOptions,
  MemoryExportBundle,
  MemoryExportFilter,
  MemoryExportMemory,
  MemoryLayer,
  MemoryProvenance,
  MemoryRecord,
  MemoryRecordInput,
  MemoryRepositoryPort,
  MemoryRevisionInput,
  MemoryScope,
  MemorySearchQuery,
  MemorySourceKind,
  MemoryStatus,
  MemoryVersionRecord,
} from "@/server/contracts/memory.contracts";

/** Teto de retrieval do D2. O teto **efetivo** é `policy.maxResults`
 * (`resolveMemoryResultLimit`); este é o limite quando o chamador não pede um. */
const DEFAULT_SEARCH_LIMIT = 20;
/** Guarda de sanidade do port: `query.limit` não pode virar varredura sem fim. */
const MAX_SEARCH_LIMIT = 100;

/** Camada default do append quando o candidato não declara uma (declarado no
 * claim): L2 (episódica) é a observação de conversa/tool que o write path de
 * hoje produz. L1 (sessão, 30 d) como default silencioso descartaria memória
 * cedo demais para ser um default. */
const DEFAULT_MEMORY_LAYER: MemoryLayer = "L2";
/** Teto do read model da trilha de auditoria (mesma guarda do retrieval). */
const MAX_ACCESS_LOG_LIMIT = 200;
const DEFAULT_ACCESS_LOG_LIMIT = 50;

type MemoryRow = typeof aiMemories.$inferSelect;
type MemorySourceRow = typeof aiMemorySources.$inferSelect;
type MemoryVersionRow = typeof aiMemoryVersions.$inferSelect;
type MemoryConflictRow = typeof aiMemoryConflicts.$inferSelect;
type MemoryAccessLogRow = typeof aiMemoryAccessLog.$inferSelect;

/* ------------------------------------------------------------------------- *
 * Chave de dedup (SD-C3-1) — função pura, sem banco e sem estado.
 *
 * `dedup_key = sha256(scope ‖ 0x1f ‖ discriminador ‖ 0x1f ‖ conteúdo
 * normalizado)` em hex minúsculo. O separador é o US de controle (0x1f), que
 * não aparece em texto normalizado — dois pares (scope, discriminador) com
 * conteúdos diferentes não podem produzir a mesma string concatenada.
 *
 * O **discriminador** é o que impede a perda silenciosa que uma chave só de
 * `scope + conteúdo` causaria: dois usuários do mesmo tenant com o mesmo texto
 * são memórias distintas, e duas conversas também. Em `scope='tenant'` não há
 * discriminador (a memória é do tenant inteiro).
 *
 * Normalização: NFC + remoção dos caracteres de formatação invisíveis + `trim`
 * + colapso de espaços internos. Os invisíveis removidos são a **categoria
 * Unicode `Cf` inteira** (`\p{Cf}`), não só o mínimo citado pelo veredicto
 * (`U+200B`/`U+200C`/`U+200D`/`U+2060`/`U+FEFF`): a categoria é fechada,
 * estável e cobre também o hífen suave (`U+00AD`) e os controles de direção
 * (`U+200E`/`U+200F`, `U+202A-202E`, `U+2066-2069`), que são o mesmo tipo de
 * ruído — uma lista explícita envelheceria a cada versão do Unicode e deixaria
 * passar os vizinhos. Sem isso, texto **visualmente idêntico** que difere só
 * por um `U+200B` (que o `\s` do JS não cobre) cria memória nova em vez de
 * deduplicar. **Caixa não é normalizada** (decisão registrada no
 * spec-card/T-testes): "Margem" e "margem" são conteúdos diferentes, e
 * colapsá-los exigiria uma regra de equivalência que a fonte não fixa. Tudo
 * isso vale **só para a chave**: o conteúdo **armazenado** continua sendo o do
 * chamador, caractere por caractere.
 * ------------------------------------------------------------------------- */

/** Separador de campo do hash (US, 0x1f) — fora dos caracteres de texto útil. */
const DEDUP_FIELD_SEPARATOR = "\u001f";

export interface MemoryDedupKeyInput {
  scope: MemoryScope;
  content: string;
  /** Autor da gravação; discriminador quando `scope='user'`. */
  userId: string;
  /** Conversa; discriminador quando `scope='conversation'`. */
  conversationId?: string | null;
}

/** Normalização do conteúdo para a chave: NFC, remoção dos caracteres de
 * formatação invisíveis (categoria `Cf`), `trim` e espaços internos colapsados
 * num único espaço ASCII (o `\s` do JS cobre NBSP e quebras). */
export function normalizeMemoryContent(content: string): string {
  return content
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Discriminador da chave por escopo (SD-C3-1): `user_id` em `user`, a conversa
 * em `conversation` e vazio em `tenant`. */
export function memoryDedupDiscriminator(input: MemoryDedupKeyInput): string {
  if (input.scope === "user") return input.userId;
  if (input.scope === "conversation") return input.conversationId ?? "";
  return "";
}

export function computeMemoryDedupKey(input: MemoryDedupKeyInput): string {
  const payload = [
    input.scope,
    memoryDedupDiscriminator(input),
    normalizeMemoryContent(input.content),
  ].join(DEDUP_FIELD_SEPARATOR);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

const SCOPE_BY_VALUE: Record<string, MemoryScope | undefined> = {
  tenant: "tenant",
  user: "user",
  conversation: "conversation",
};
const SOURCE_KIND_BY_VALUE: Record<string, MemorySourceKind | undefined> = {
  user: "user",
  tool: "tool",
  model: "model",
  import: "import",
};
const STATUS_BY_VALUE: Record<string, MemoryStatus | undefined> = {
  active: "active",
  superseded: "superseded",
  expired: "expired",
};
const CONFLICT_STATUS_BY_VALUE: Record<string, MemoryConflictStatus | undefined> = {
  open: "open",
  dismissed: "dismissed",
  resolved: "resolved",
};

/** O `text` das tabelas é aberto no banco (o CHECK é a fronteira real); estes
 * conversores só traduzem o valor verificado para o tipo do contrato. */
function asScope(value: string): MemoryScope {
  const scope = SCOPE_BY_VALUE[value];
  if (scope === undefined)
    throw new ApplicationError("DATABASE_ERROR", {
      message: `scope inválido persistido em ai_memories: ${value}`,
    });
  return scope;
}

function asStatus(value: string): MemoryStatus {
  const status = STATUS_BY_VALUE[value];
  if (status === undefined)
    throw new ApplicationError("DATABASE_ERROR", {
      message: `status inválido persistido em ai_memories: ${value}`,
    });
  return status;
}

const LAYER_BY_VALUE: Record<string, MemoryLayer | undefined> = {
  L1: "L1",
  L2: "L2",
  L3: "L3",
  L4: "L4",
  L5: "L5",
};

/** Camada do candidato: o tipo do contrato já é fechado, mas o valor pode vir
 * de um payload — camada fora do vocabulário é erro do chamador (o CHECK do
 * banco é a segunda barreira, não a primeira). */
function resolveLayer(value: MemoryLayer | undefined): MemoryLayer {
  if (value === undefined) return DEFAULT_MEMORY_LAYER;
  const layer = LAYER_BY_VALUE[value];
  if (layer === undefined) {
    throw new ApplicationError("VALIDATION_ERROR", {
      message: `camada de memória inválida: ${String(value)}`,
    });
  }
  return layer;
}

function asLayer(value: string): MemoryLayer {
  const layer = LAYER_BY_VALUE[value];
  if (layer === undefined) {
    throw new ApplicationError("DATABASE_ERROR", {
      message: `layer inválido persistido em ai_memories: ${value}`,
    });
  }
  return layer;
}

function asSourceKind(value: string): MemorySourceKind {
  const kind = SOURCE_KIND_BY_VALUE[value];
  if (kind === undefined) {
    throw new ApplicationError("DATABASE_ERROR", {
      message: `source_kind inválido persistido em ai_memory_sources: ${value}`,
    });
  }
  return kind;
}

function toProvenance(source: MemorySourceRow): MemoryProvenance {
  return {
    sourceKind: asSourceKind(source.sourceKind),
    sourceId: source.sourceRef ?? source.id,
    conversationId: source.conversationId ?? undefined,
    capturedAt: source.capturedAt,
    inferred: source.inferred,
    confidence: source.confidence,
  };
}

function toRecord(row: MemoryRow, source: MemorySourceRow | undefined): MemoryRecord {
  return {
    id: row.id,
    scope: asScope(row.scope),
    layer: asLayer(row.layer),
    content: row.content,
    provenance: source ? toProvenance(source) : undefined,
    importance: row.importance,
    status: asStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

/** Limite efetivo do lote: pedido inválido não vira `limit` implícito nem
 * varredura — falha alto, como o contrato (`resolveMemoryResultLimit`). */
function resolveLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ApplicationError("VALIDATION_ERROR", {
      message: `limite de busca inválido: ${requested}`,
    });
  }
  return Math.min(requested, MAX_SEARCH_LIMIT);
}

function asConflictStatus(value: string): MemoryConflictStatus {
  const status = CONFLICT_STATUS_BY_VALUE[value];
  if (status === undefined) {
    throw new ApplicationError("DATABASE_ERROR", {
      message: `status inválido persistido em ai_memory_conflicts: ${value}`,
    });
  }
  return status;
}

function toConflictRecord(row: MemoryConflictRow): MemoryConflictRecord {
  return {
    id: row.id,
    memoryId: row.memoryId,
    candidateContent: row.candidateContent,
    candidateDedupKey: row.candidateDedupKey,
    status: asConflictStatus(row.status),
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
  };
}

/** Fontes mais antigas por memória (`captured_at` asc, `id` asc): é a
 * proveniência primária do read model, e é o mesmo critério em `append`,
 * `revise` e `search` — um helper só, para os três não divergirem. */
async function primarySourcesFor(
  tx: DatabaseTransaction,
  tenantId: string,
  memoryIds: readonly string[],
): Promise<Map<string, MemorySourceRow>> {
  if (memoryIds.length === 0) return new Map();
  const sources = await tx
    .select()
    .from(aiMemorySources)
    .where(
      and(
        eq(aiMemorySources.tenantId, tenantId),
        inArray(aiMemorySources.memoryId, [...memoryIds]),
      ),
    )
    .orderBy(asc(aiMemorySources.capturedAt), asc(aiMemorySources.id));

  const primary = new Map<string, MemorySourceRow>();
  for (const source of sources) {
    if (!primary.has(source.memoryId)) primary.set(source.memoryId, source);
  }
  return primary;
}

/** Grava a observação declarada (proveniência 1:N) na mesma transação da
 * memória: sem ela a fonte não existe, e o read model nunca inventa um objeto
 * sintético. Usada pelo append e pela revisão, que são as duas escritas que
 * produzem uma observação nova. */
async function insertSource(
  tx: DatabaseTransaction,
  tenantId: string,
  userId: string,
  memoryId: string,
  provenance: MemoryProvenance,
): Promise<MemorySourceRow> {
  const sources = await tx
    .insert(aiMemorySources)
    .values({
      tenantId,
      memoryId,
      sourceKind: provenance.sourceKind,
      sourceRef: provenance.sourceId,
      conversationId: provenance.conversationId ?? null,
      userId,
      inferred: provenance.inferred,
      confidence: provenance.confidence,
      capturedAt: provenance.capturedAt,
    })
    .returning();
  const source = sources[0];
  if (!source) throw new ApplicationError("DATABASE_ERROR");
  return source;
}

/** TTL da camada lido de `ai_memory_policies` (§15.1/L5, SD-D4-A): a **maior
 * versão** por camada decide. Nenhum TTL vive em constante de código nem em SQL
 * — o valor é a linha. Camada sem política publicada falha alto: um append sem
 * TTL conhecido seria retenção indefinida silenciosa (INV-013). */
async function resolveLayerTtlSeconds(
  tx: DatabaseTransaction,
  layer: MemoryLayer,
): Promise<number | null> {
  const policies = await tx
    .select({ ttlSeconds: aiMemoryPolicies.ttlSeconds })
    .from(aiMemoryPolicies)
    .where(eq(aiMemoryPolicies.layer, layer))
    .orderBy(desc(aiMemoryPolicies.version))
    .limit(1);
  const policy = policies[0];
  if (!policy) {
    throw new ApplicationError("INTERNAL_ERROR", {
      message: `camada ${layer} sem política de retenção publicada em ai_memory_policies`,
    });
  }
  return policy.ttlSeconds;
}

/** Grava a linha de auditoria (§15.4/D4) na MESMA transação da operação: sem o
 * log a operação não commita, então não existe acesso/delete/export sem
 * rastro. O log não guarda `content` nem o texto da consulta. */
async function insertAccessLog(
  tx: DatabaseTransaction,
  context: RequestContext,
  entry: {
    action: MemoryAccessAction;
    result: MemoryAccessResult;
    memoryId: string | null;
    rowCount: number;
  },
): Promise<void> {
  await tx.insert(aiMemoryAccessLog).values({
    tenantId: context.tenantId,
    userId: context.userId,
    action: entry.action,
    memoryId: entry.memoryId,
    result: entry.result,
    rowCount: entry.rowCount,
  });
}

/** Todas as fontes por memória (`captured_at` asc, `id` asc) — a exportação
 * carrega a proveniência **inteira**, não só a primária do read model. */
async function allSourcesFor(
  tx: DatabaseTransaction,
  tenantId: string,
  memoryIds: readonly string[],
): Promise<Map<string, MemorySourceRow[]>> {
  const grouped = new Map<string, MemorySourceRow[]>();
  if (memoryIds.length === 0) return grouped;
  const sources = await tx
    .select()
    .from(aiMemorySources)
    .where(
      and(
        eq(aiMemorySources.tenantId, tenantId),
        inArray(aiMemorySources.memoryId, [...memoryIds]),
      ),
    )
    .orderBy(asc(aiMemorySources.capturedAt), asc(aiMemorySources.id));
  for (const source of sources) {
    const bucket = grouped.get(source.memoryId);
    if (bucket) bucket.push(source);
    else grouped.set(source.memoryId, [source]);
  }
  return grouped;
}

/** Histórico por memória, em ordem de `version` (mesma leitura de
 * `listVersions`, sem o `superseded` derivado que a exportação não usa). */
async function versionsFor(
  tx: DatabaseTransaction,
  tenantId: string,
  memoryIds: readonly string[],
): Promise<Map<string, MemoryVersionRow[]>> {
  const grouped = new Map<string, MemoryVersionRow[]>();
  if (memoryIds.length === 0) return grouped;
  const rows = await tx
    .select()
    .from(aiMemoryVersions)
    .where(
      and(
        eq(aiMemoryVersions.tenantId, tenantId),
        inArray(aiMemoryVersions.memoryId, [...memoryIds]),
      ),
    )
    .orderBy(asc(aiMemoryVersions.version), asc(aiMemoryVersions.id));
  for (const row of rows) {
    const bucket = grouped.get(row.memoryId);
    if (bucket) bucket.push(row);
    else grouped.set(row.memoryId, [row]);
  }
  return grouped;
}

function toVersionRecord(row: MemoryVersionRow, latestVersion: number): MemoryVersionRecord {
  return {
    id: row.id,
    memoryId: row.memoryId,
    version: row.version,
    content: row.content,
    dedupKey: row.dedupKey,
    createdAt: row.createdAt,
    superseded: row.version < latestVersion,
  };
}

function toAccessLogEntry(row: MemoryAccessLogRow): MemoryAccessLogEntry {
  return {
    id: row.id,
    userId: row.userId,
    action: row.action as MemoryAccessAction,
    memoryId: row.memoryId,
    result: row.result as MemoryAccessResult,
    rowCount: row.rowCount,
    createdAt: row.createdAt,
  };
}

/** Guarda de sanidade do read model do log (mesma forma de `resolveLimit`). */
function resolveAccessLogLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_ACCESS_LOG_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ApplicationError("VALIDATION_ERROR", {
      message: `limite de auditoria inválido: ${requested}`,
    });
  }
  return Math.min(requested, MAX_ACCESS_LOG_LIMIT);
}

/** Violação de unicidade do Postgres (SQLSTATE `23505`). O Drizzle embrulha o
 * erro do driver (`DrizzleQueryError`), então o SQLSTATE tem de ser buscado na
 * cadeia de causas — mesma técnica de `scripts/db/test-memory.ts`. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "23505") return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

export class DrizzleMemoryRepository implements MemoryRepositoryPort {
  /**
   * Grava a memória e suas fontes no executor recebido. Os dois INSERTs usam a
   * MESMA transação: a memória nunca fica commitada sem as fontes que a
   * justificam, e o tenant do GUC da transação é o único aceito pela policy
   * (`WITH CHECK`).
   *
   * Dedup (SD-C3-10): o `INSERT … ON CONFLICT (tenant_id, dedup_key) WHERE
   * status='active' DO NOTHING RETURNING *` deixa o **índice único parcial**
   * decidir a corrida — sem advisory lock, sem `SELECT` prévio que possa
   * envelhecer entre a leitura e a escrita. Quando nada é inserido a chave já
   * identificava uma memória ativa do tenant: a existente é lida e devolvida com
   * `duplicated: true`, e **nada** é gravado (nem fonte, nem versão).
   */
  async append(
    context: RequestContext,
    input: MemoryRecordInput,
    executor: Executor = context.transaction,
  ): Promise<MemoryAppendResult> {
    // §9.2 — o adapter estreita o handle neutro do contexto/executor para a
    // transação do driver; o contrato (`MemoryRepositoryPort`) segue agnostic.
    const tx = executor as DatabaseTransaction;
    const dedupKey = computeMemoryDedupKey({
      scope: input.scope,
      content: input.content,
      userId: context.userId,
      conversationId: input.provenance?.conversationId ?? null,
    });

    // TTL por camada (§23.2/H-12): o valor vem da policy versionada, e o fim da
    // validade é calculado no relógio do BANCO (`now()`), não no do processo —
    // `created_at` e `expires_at` ficam na mesma escala de tempo.
    const layer = resolveLayer(input.layer);
    const ttlSeconds = await resolveLayerTtlSeconds(tx, layer);

    const inserted = await tx
      .insert(aiMemories)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        scope: input.scope,
        layer,
        content: input.content,
        dedupKey,
        expiresAt: ttlSeconds === null ? null : sql`now() + make_interval(secs => ${ttlSeconds})`,
        importance: input.importance ?? 0,
        confidence: input.provenance?.confidence ?? null,
      })
      .onConflictDoNothing({
        target: [aiMemories.tenantId, aiMemories.dedupKey],
        // Predicado do índice único **parcial** (SD-C3-2/10): o árbitro é
        // `(tenant_id, dedup_key) WHERE status='active'`, então uma memória
        // substituída não bloqueia a gravação de um ativo novo.
        where: sql`${aiMemories.status} = 'active'`,
      })
      .returning();
    const row = inserted[0];

    if (!row) {
      const existing = await tx
        .select()
        .from(aiMemories)
        .where(
          and(
            eq(aiMemories.tenantId, context.tenantId),
            eq(aiMemories.dedupKey, dedupKey),
            eq(aiMemories.status, "active"),
          ),
        )
        .limit(1);
      const duplicate = existing[0];
      // O `DO NOTHING` só é alcançado pelo índice único parcial de
      // `(tenant_id, dedup_key) WHERE status='active'`, então a linha existe;
      // ausência aqui é estado impossível, não um "não encontrado".
      if (!duplicate) throw new ApplicationError("DATABASE_ERROR");
      const primary = await primarySourcesFor(tx, context.tenantId, [duplicate.id]);
      return { record: toRecord(duplicate, primary.get(duplicate.id)), duplicated: true };
    }

    const provenance = input.provenance;
    if (!provenance) return { record: toRecord(row, undefined), duplicated: false };

    const source = await insertSource(tx, context.tenantId, context.userId, row.id, provenance);
    return { record: toRecord(row, source), duplicated: false };
  }

  /**
   * Revisão do head (§15.6/D3, SD-C3-4): arquiva o estado **substituído** em
   * `ai_memory_versions` e atualiza a memória in-place — nunca o contrário, para
   * que a versão anterior permaneça byte a byte inalterada (§34).
   *
   * `SELECT … FOR UPDATE` no head serializa revisões concorrentes da mesma
   * memória: o `max(version) + 1` lido logo depois é estável e o `UNIQUE
   * (tenant_id, memory_id, version)` é o backstop (nada de advisory lock —
   * SD-C3-10 só proíbe coordenação em código para o **dedup**).
   *
   * Revisão sem alteração de conteúdo (mesma chave de dedup) falha alto em vez
   * de poluir o histórico com uma versão idêntica ao head.
   */
  async revise(
    context: RequestContext,
    memoryId: string,
    revision: MemoryRevisionInput,
    executor: Executor = context.transaction,
  ): Promise<MemoryRecord> {
    const tx = executor as DatabaseTransaction;
    const found = await tx
      .select()
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.tenantId, context.tenantId),
          eq(aiMemories.id, memoryId),
          eq(aiMemories.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    const head = found[0];
    if (!head) {
      throw new ApplicationError("NOT_FOUND", {
        message: `memória ativa ${memoryId} inexistente no tenant corrente`,
      });
    }

    const primaryBefore = await primarySourcesFor(tx, context.tenantId, [head.id]);
    const dedupKey = computeMemoryDedupKey({
      scope: asScope(head.scope),
      content: revision.content,
      userId: head.userId,
      // A revisão sem proveniência declarada mantém o discriminador da memória
      // (a conversa da fonte primária); sem isso a chave derivaria de um
      // discriminador vazio e a memória perderia a continuidade do dedup.
      conversationId:
        revision.provenance?.conversationId ?? primaryBefore.get(head.id)?.conversationId ?? null,
    });
    if (dedupKey === head.dedupKey) {
      throw new ApplicationError("VALIDATION_ERROR", {
        message: `revisão de ${memoryId} sem alteração de conteúdo (mesma chave de dedup)`,
      });
    }

    const maxVersion = await tx
      .select({ version: sql<number>`coalesce(max(${aiMemoryVersions.version}), 0)` })
      .from(aiMemoryVersions)
      .where(
        and(
          eq(aiMemoryVersions.tenantId, context.tenantId),
          eq(aiMemoryVersions.memoryId, head.id),
        ),
      );
    const archived = await tx
      .insert(aiMemoryVersions)
      .values({
        tenantId: context.tenantId,
        memoryId: head.id,
        version: (maxVersion[0]?.version ?? 0) + 1,
        content: head.content,
        dedupKey: head.dedupKey,
      })
      .returning();
    if (!archived[0]) throw new ApplicationError("DATABASE_ERROR");

    // O conteúdo revisado pode ser o head ativo de OUTRA memória do tenant: o
    // índice único parcial `(tenant_id, dedup_key) WHERE status='active'`
    // recusa o `UPDATE` com 23505 — é o único índice único de `ai_memories`
    // fora a PK, e a PK não é tocada por uma revisão (o `id` não muda). Sem
    // esta rede o erro do driver vaza cru (`isApplicationError:false` → 500);
    // aqui vira CONFLICT. Erro que NÃO é violação de unicidade é relançado como
    // veio, e a versão arquivada acima é desfeita pelo rollback da transação —
    // a revisão colidente não deixa rastro (nem memória, nem versão).
    let updated: MemoryRow[];
    try {
      updated = await tx
        .update(aiMemories)
        .set({
          content: revision.content,
          dedupKey,
          importance: revision.importance ?? head.importance,
          confidence: revision.provenance?.confidence ?? head.confidence,
          updatedAt: sql`now()`,
        })
        .where(and(eq(aiMemories.tenantId, context.tenantId), eq(aiMemories.id, head.id)))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApplicationError("CONFLICT", {
          cause: error,
          message: `revisão de ${memoryId} colide com uma memória ativa do tenant (a chave de dedup do conteúdo revisado já está em uso)`,
        });
      }
      throw error;
    }
    const row = updated[0];
    if (!row) throw new ApplicationError("DATABASE_ERROR");

    const provenance = revision.provenance;
    if (!provenance) return toRecord(row, primaryBefore.get(row.id));
    // A observação da revisão é gravada como fonte (proveniência 1:N) e o read
    // model é relido: a fonte primária é a mais antiga, e a nova pode ser ela.
    await insertSource(tx, context.tenantId, context.userId, row.id, provenance);
    const primaryAfter = await primarySourcesFor(tx, context.tenantId, [row.id]);
    return toRecord(row, primaryAfter.get(row.id));
  }

  /**
   * Registro de conflito (§15.6/D3, SD-C3-5/6): D3 **não** julga contradição
   * semântica nem resolve conflito — grava o candidato contraditório e devolve a
   * linha. A memória ativa não é tocada: não existe `UPDATE` em `ai_memories`
   * neste caminho, então "o ativo nunca é sobrescrito por um conflito" é uma
   * propriedade do código, não uma promessa.
   */
  async recordConflict(
    context: RequestContext,
    memoryId: string,
    candidate: MemoryCandidate,
    executor: Executor = context.transaction,
  ): Promise<MemoryConflictRecord> {
    const tx = executor as DatabaseTransaction;
    const found = await tx
      .select({ id: aiMemories.id })
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.tenantId, context.tenantId),
          eq(aiMemories.id, memoryId),
          eq(aiMemories.status, "active"),
        ),
      )
      .limit(1);
    if (!found[0]) {
      throw new ApplicationError("NOT_FOUND", {
        message: `memória ativa ${memoryId} inexistente no tenant corrente`,
      });
    }

    const inserted = await tx
      .insert(aiMemoryConflicts)
      .values({
        tenantId: context.tenantId,
        memoryId,
        candidateContent: candidate.content,
        candidateDedupKey: computeMemoryDedupKey({
          scope: candidate.scope,
          content: candidate.content,
          userId: context.userId,
          conversationId: candidate.provenance?.conversationId ?? null,
        }),
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new ApplicationError("DATABASE_ERROR");
    return toConflictRecord(row);
  }

  /**
   * Histórico da memória (§15.6/D3, SD-C3-8), em ordem de `version`. A marcação
   * `superseded` é **derivada em SQL** (não há coluna nem `UPDATE`): o head é a
   * versão corrente da memória, então toda versão arquivada tem sucessor de
   * número maior — o `max(...) over (partition by memory_id)` é o número da
   * última versão arquivada e o head ocupa a seguinte. Leitura do tenant
   * corrente apenas (RLS + predicado explícito).
   */
  async listVersions(
    context: RequestContext,
    memoryId: string,
    executor: Executor = context.transaction,
  ): Promise<readonly MemoryVersionRecord[]> {
    const tx = executor as DatabaseTransaction;
    const rows = await tx
      .select({
        id: aiMemoryVersions.id,
        memoryId: aiMemoryVersions.memoryId,
        version: aiMemoryVersions.version,
        content: aiMemoryVersions.content,
        dedupKey: aiMemoryVersions.dedupKey,
        createdAt: aiMemoryVersions.createdAt,
        superseded: sql<boolean>`${aiMemoryVersions.version} < max(${aiMemoryVersions.version}) over (partition by ${aiMemoryVersions.memoryId}) + 1`,
      })
      .from(aiMemoryVersions)
      .where(
        and(
          eq(aiMemoryVersions.tenantId, context.tenantId),
          eq(aiMemoryVersions.memoryId, memoryId),
        ),
      )
      .orderBy(asc(aiMemoryVersions.version), asc(aiMemoryVersions.id));
    return rows;
  }

  /**
   * Conflitos registrados do tenant corrente (§15.6/D3, SD-C3-8), do mais
   * recente para o mais antigo, com filtro opcional de status e de memória.
   * Quem muda o status é o serviço (o `UPDATE` é concedido em
   * `ai_memory_conflicts`, não usado aqui).
   */
  async listConflicts(
    context: RequestContext,
    filter: MemoryConflictFilter = {},
    executor: Executor = context.transaction,
  ): Promise<readonly MemoryConflictRecord[]> {
    const tx = executor as DatabaseTransaction;
    const rows = await tx
      .select()
      .from(aiMemoryConflicts)
      .where(
        and(
          eq(aiMemoryConflicts.tenantId, context.tenantId),
          filter.status === undefined ? undefined : eq(aiMemoryConflicts.status, filter.status),
          filter.memoryId === undefined
            ? undefined
            : eq(aiMemoryConflicts.memoryId, filter.memoryId),
        ),
      )
      .orderBy(desc(aiMemoryConflicts.detectedAt), asc(aiMemoryConflicts.id));
    return rows.map(toConflictRecord);
  }

  /**
   * Retrieval do tenant corrente: só `active` **e dentro da validade**
   * (`expires_at` nulo ou futuro — defesa em profundidade enquanto o expirador
   * não rodou), com o filtro textual aplicado por substring parametrizada
   * (`position(lower($n) in lower(content))`), sem wildcard interpretável e sem
   * concatenação de SQL. Ordenação determinística por (`created_at` desc, `id`)
   * — a composição de score §15.7 é D6.
   *
   * Toda busca grava a linha de auditoria `access` (mesmo com 0 resultados:
   * "acesso sem resultado" também é auditável), na MESMA transação — um log que
   * não grava derruba a busca inteira (INV-013).
   */
  async search(
    context: RequestContext,
    query: MemorySearchQuery,
    executor: Executor = context.transaction,
  ): Promise<readonly MemoryRecord[]> {
    const tx = executor as DatabaseTransaction;
    const limit = resolveLimit(query.limit);
    const text = query.text.normalize("NFC").trim();
    const scopes = query.scopes ?? [];

    const rows = await tx
      .select()
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.tenantId, context.tenantId),
          eq(aiMemories.status, "active"),
          or(isNull(aiMemories.expiresAt), gt(aiMemories.expiresAt, sql`now()`)),
          scopes.length > 0 ? inArray(aiMemories.scope, [...scopes]) : undefined,
          text === ""
            ? undefined
            : sql`position(lower(${text}) in lower(${aiMemories.content})) > 0`,
        ),
      )
      .orderBy(desc(aiMemories.createdAt), asc(aiMemories.id))
      .limit(limit);

    await insertAccessLog(tx, context, {
      action: "access",
      result: "allowed",
      memoryId: null,
      rowCount: rows.length,
    });
    if (rows.length === 0) return [];

    const primary = await primarySourcesFor(
      tx,
      context.tenantId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toRecord(row, primary.get(row.id)));
  }

  /**
   * §43 — delete: apaga a memória do tenant corrente e devolve `true` só quando
   * uma linha foi removida. Id inexistente (ou de outro tenant, invisível por
   * RLS) devolve `false` sem erro, como o contrato manda. As fontes caem por
   * `ON DELETE cascade`, na mesma transação.
   *
   * D3 (SD-C3-9): memória com histórico ou conflito registrado é **recusada**
   * (`false`, sem erro) — o expurgo é caminho explícito. A recusa é verificada
   * na aplicação **e** garantida pelo `ON DELETE RESTRICT` das duas tabelas: se
   * a checagem fosse removida, o banco abortaria a transação em vez de apagar o
   * histórico em silêncio.
   *
   * Com `purgeHistory: true` as versões e os conflitos caem explicitamente antes
   * da memória, na MESMA transação (as fontes pela cascata da memória, que é o
   * único caminho possível: `app_runtime` não tem `DELETE` em
   * `ai_memory_sources`). O expurgo é o caminho LGPD (§48) e roda **sob a role
   * de aplicação** desde a 0019 (SD-C3-12 concedeu `DELETE` em
   * `ai_memory_versions`/`ai_memory_conflicts`; a reescrita da história segue
   * negada porque o `UPDATE` continua fora do grant).
   *
   * Autorização por escopo (§43/D4, aceite e): memória `scope='user'` só é
   * apagável pelo próprio autor ou por owner do tenant — a checagem é de
   * aplicação **e** o predicado do `DELETE` repete a condição, então nem um
   * caminho alternativo apaga memória pessoal de terceiro dentro do tenant.
   *
   * Todo delete — inclusive os recusados — grava a linha de auditoria `delete`
   * com o resultado (`allowed`/`not_found`/`refused`) e o alvo.
   */
  async delete(
    context: RequestContext,
    id: string,
    options: MemoryDeleteOptions = { purgeHistory: false },
    executor: Executor = context.transaction,
  ): Promise<boolean> {
    const tx = executor as DatabaseTransaction;
    const found = await tx
      .select({ id: aiMemories.id, scope: aiMemories.scope, userId: aiMemories.userId })
      .from(aiMemories)
      .where(and(eq(aiMemories.tenantId, context.tenantId), eq(aiMemories.id, id)))
      .limit(1);
    const target = found[0];
    if (!target) {
      await insertAccessLog(tx, context, {
        action: "delete",
        result: "not_found",
        memoryId: id,
        rowCount: 0,
      });
      return false;
    }

    // Autorização por escopo (§43/D4, aceite e): memória `scope='user'` de outro
    // autor só cai por quem tem `has_tenant_owner_access` — o MESMO predicado do
    // banco que o `DELETE` repete na cláusula, então não existe janela entre a
    // checagem (que produz a linha de auditoria) e a remoção.
    const foreignPersonalMemory = target.scope === "user" && target.userId !== context.userId;
    if (foreignPersonalMemory) {
      const ownerAccess = await tx.execute<{ owner: boolean }>(
        sql`select app_private.has_tenant_owner_access(${context.tenantId}::uuid) as owner`,
      );
      if (ownerAccess.rows[0]?.owner !== true) {
        await insertAccessLog(tx, context, {
          action: "delete",
          result: "refused",
          memoryId: id,
          rowCount: 0,
        });
        return false;
      }
    }

    if (options.purgeHistory) {
      await tx
        .delete(aiMemoryConflicts)
        .where(
          and(eq(aiMemoryConflicts.tenantId, context.tenantId), eq(aiMemoryConflicts.memoryId, id)),
        );
      await tx
        .delete(aiMemoryVersions)
        .where(
          and(eq(aiMemoryVersions.tenantId, context.tenantId), eq(aiMemoryVersions.memoryId, id)),
        );
    } else {
      const history = await tx
        .select({ one: sql<number>`1` })
        .from(aiMemoryVersions)
        .where(
          and(eq(aiMemoryVersions.tenantId, context.tenantId), eq(aiMemoryVersions.memoryId, id)),
        )
        .limit(1);
      if (history.length > 0) {
        await insertAccessLog(tx, context, {
          action: "delete",
          result: "refused",
          memoryId: id,
          rowCount: 0,
        });
        return false;
      }
      const conflicts = await tx
        .select({ one: sql<number>`1` })
        .from(aiMemoryConflicts)
        .where(
          and(eq(aiMemoryConflicts.tenantId, context.tenantId), eq(aiMemoryConflicts.memoryId, id)),
        )
        .limit(1);
      if (conflicts.length > 0) {
        await insertAccessLog(tx, context, {
          action: "delete",
          result: "refused",
          memoryId: id,
          rowCount: 0,
        });
        return false;
      }
    }

    const deleted = await tx
      .delete(aiMemories)
      .where(
        and(
          eq(aiMemories.tenantId, context.tenantId),
          eq(aiMemories.id, id),
          // O predicado repete a autorização por escopo: a checagem acima é a
          // mensagem de auditoria, esta linha é o que o banco executa.
          or(
            ne(aiMemories.scope, "user"),
            eq(aiMemories.userId, context.userId),
            sql`app_private.has_tenant_owner_access(${context.tenantId}::uuid)`,
          ),
        ),
      )
      .returning({ id: aiMemories.id });
    await insertAccessLog(tx, context, {
      action: "delete",
      result: "allowed",
      memoryId: id,
      rowCount: deleted.length,
    });
    return deleted.length === 1;
  }

  /**
   * Portabilidade (§43/D4, H-12 critério 4): devolve **todo** o conjunto do
   * tenant do contexto — todas as camadas e todos os estados — com as fontes
   * (proveniência inteira) e o histórico de versões de cada memória. Nenhuma
   * linha de outro tenant entra no pacote: o predicado de `tenant_id` é
   * explícito em todas as consultas e a RLS é a segunda barreira (INV-008).
   *
   * Sem `has_tenant_access` a exportação **falha alto** em vez de devolver
   * pacote vazio: uma identidade sem vínculo com o tenant não pode receber
   * "sucesso" com zero memórias (INV-013), e a checagem roda **antes** de
   * qualquer consulta de dado. A linha de auditoria `export` acompanha a
   * operação, com o número de memórias do pacote.
   */
  async export(
    context: RequestContext,
    filter: MemoryExportFilter = {},
    executor: Executor = context.transaction,
  ): Promise<MemoryExportBundle> {
    const tx = executor as DatabaseTransaction;
    const access = await tx.execute<{ allowed: boolean }>(
      sql`select app_private.has_tenant_access(${context.tenantId}::uuid) as allowed`,
    );
    if (access.rows[0]?.allowed !== true) {
      throw new ApplicationError("AUTHORIZATION_ERROR", {
        message: `exportação negada: a identidade ${context.userId} não tem acesso ao tenant ${context.tenantId}`,
      });
    }

    const scopes = filter.scopes ?? [];
    const layers = filter.layers ?? [];
    const rows = await tx
      .select()
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.tenantId, context.tenantId),
          scopes.length > 0 ? inArray(aiMemories.scope, [...scopes]) : undefined,
          layers.length > 0 ? inArray(aiMemories.layer, [...layers]) : undefined,
        ),
      )
      .orderBy(asc(aiMemories.createdAt), asc(aiMemories.id));

    const memoryIds = rows.map((row) => row.id);
    const [sources, versions, primary] = await Promise.all([
      allSourcesFor(tx, context.tenantId, memoryIds),
      versionsFor(tx, context.tenantId, memoryIds),
      primarySourcesFor(tx, context.tenantId, memoryIds),
    ]);

    const memories: MemoryExportMemory[] = rows.map((row) => {
      const history = versions.get(row.id) ?? [];
      const latestVersion = history.reduce((max, version) => Math.max(max, version.version), 0);
      return {
        record: toRecord(row, primary.get(row.id)),
        sources: (sources.get(row.id) ?? []).map(toProvenance),
        versions: history.map((version) => toVersionRecord(version, latestVersion)),
      };
    });

    await insertAccessLog(tx, context, {
      action: "export",
      result: "allowed",
      memoryId: null,
      rowCount: memories.length,
    });
    return { tenantId: context.tenantId, memories };
  }

  /**
   * Expirador do TTL (§23.2/H-12): passa a `expired` as memórias **ativas** do
   * tenant corrente cujo `expires_at` venceu, devolvendo os ids afetados.
   *
   * Idempotente por construção: a segunda passada não encontra mais
   * `status='active'` vencida e devolve `[]`. Falha do banco **sobe** como erro
   * — nada de `try/catch` transformando erro em "0 expiradas" (INV-013). Não há
   * `DELETE`: expirar é transição de estado, e a linha permanece auditável e
   * exportável; a eliminação física é o `delete`/`purgeHistory`.
   */
  async expireDue(
    context: RequestContext,
    executor: Executor = context.transaction,
  ): Promise<readonly string[]> {
    const tx = executor as DatabaseTransaction;
    const expired = await tx
      .update(aiMemories)
      .set({ status: "expired", updatedAt: sql`now()` })
      .where(
        and(
          eq(aiMemories.tenantId, context.tenantId),
          eq(aiMemories.status, "active"),
          isNotNull(aiMemories.expiresAt),
          lte(aiMemories.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: aiMemories.id });
    return expired.map((row) => row.id);
  }

  /**
   * Read model da trilha de auditoria (§15.4/D4), do mais recente para o mais
   * antigo, sempre com o predicado de tenant (RLS como segunda barreira). O log
   * é append-only por privilégio: este é o único caminho de leitura da
   * aplicação, e ele não expõe `content` porque a tabela não o tem.
   */
  async listAccessLog(
    context: RequestContext,
    filter: MemoryAccessLogFilter = {},
    executor: Executor = context.transaction,
  ): Promise<readonly MemoryAccessLogEntry[]> {
    const tx = executor as DatabaseTransaction;
    const limit = resolveAccessLogLimit(filter.limit);
    const rows = await tx
      .select()
      .from(aiMemoryAccessLog)
      .where(
        and(
          eq(aiMemoryAccessLog.tenantId, context.tenantId),
          filter.action === undefined ? undefined : eq(aiMemoryAccessLog.action, filter.action),
          filter.memoryId === undefined
            ? undefined
            : eq(aiMemoryAccessLog.memoryId, filter.memoryId),
        ),
      )
      .orderBy(desc(aiMemoryAccessLog.createdAt), asc(aiMemoryAccessLog.id))
      .limit(limit);
    return rows.map(toAccessLogEntry);
  }
}

/** Instância de aplicação: D3/D4 consomem esta porta. */
export const memoryRepository = new DrizzleMemoryRepository();
