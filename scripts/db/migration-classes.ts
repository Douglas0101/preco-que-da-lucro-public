/**
 * Registry sidecar de classificação das migrations Drizzle (§27a).
 *
 * O Drizzle calcula sha256 do conteúdo integral de cada `drizzle/*.sql` e o
 * banco guarda esse hash em `drizzle.__drizzle_migrations`; por isso nenhum
 * cabeçalho de classe é adicionado aos SQL publicados. A classificação vive
 * aqui e é validada por `scripts/db/check-migration-classes.ts` (bijeção
 * journal ↔ registry, sha256 byte a byte e regras por classe).
 *
 * Política de classes e expansão: `docs/runbooks/migration-safety.md`.
 * Evidência gerada: `docs/evidence/migration-classification-<data>.md`.
 */

export const MIGRATION_CLASSES = [
  "SAFE",
  "ONLINE_WITH_CARE",
  "DATA_MIGRATION",
  "BREAKING",
] as const;

export type MigrationClass = (typeof MIGRATION_CLASSES)[number];

/**
 * `empty` — migration aplicada quando o banco ainda não tinha dados de
 * aplicação (as 14 atuais); `live` — havia dados e o plano de backfill/rollback
 * é obrigatório no PR.
 */
export type AppliedOn = "empty" | "live";

export interface MigrationClassEntry {
  /** Tag exata de `drizzle/meta/_journal.json` e prefixo do arquivo SQL. */
  tag: string;
  class: MigrationClass;
  /** Por que esta classe, em uma frase verificável. */
  rationale: string;
  /** Ponteiros que sustentam a classificação (SQL, testes, evidência, ADR). */
  evidence: readonly string[];
  /** sha256 byte a byte de `drizzle/<tag>.sql` (hash do Drizzle migrator). */
  sha256: string;
  /** Para ONLINE_WITH_CARE: lock/risco operacional e janela recomendada. */
  onlineCare?: string;
  /** Para DATA_MIGRATION: reexecução converge sem efeito novo. */
  idempotent?: boolean;
  /** Caminho do down em `drizzle/rollback/` (ou justificativa de ausência). */
  rollback: string;
  /** Para BREAKING: tag da migration expand que preparou a contração. */
  contractOf?: string;
  appliedOn: AppliedOn;
}

export const migrationClasses: readonly MigrationClassEntry[] = [
  {
    tag: "0000_p0_postgres_foundation",
    class: "SAFE",
    rationale:
      "Fundação do schema sobre banco vazio: apenas CREATE TABLE/INDEX/FK/CHECK, sem DML e sem alteração de objetos pré-existentes.",
    evidence: [
      "drizzle/0000_p0_postgres_foundation.sql",
      "scripts/db/test-migrations.ts (replay do chain 0002→0011)",
    ],
    sha256: "952004d7ccebd5af1c3064a350d1a2cd322c2911728b7ae6a2d239df68641743",
    rollback: "n/a — baseline do chain; recriar o banco a partir do zero",
    appliedOn: "empty",
  },
  {
    tag: "0001_p0_runtime_role_and_rls",
    class: "ONLINE_WITH_CARE",
    rationale:
      "Cria a role global app_runtime, schema app_private, funções SECURITY DEFINER e as políticas RLS base; a role é compartilhada entre databases do mesmo servidor.",
    evidence: [
      "drizzle/0001_p0_runtime_role_and_rls.sql",
      "scripts/db/test-migrations.ts (atributos da role, grants, RLS e funções)",
      "drizzle/rollback/0001_to_0000_down.sql",
    ],
    sha256: "c1bf8f25a7534f9ec154c3844da8a7000d329d8a2170d1ecd5978fe1029eaf16",
    onlineCare:
      "Aplicar fora do pico: CREATE/ALTER ROLE e REVOKE/GRANT tomam locks globais curtos; o down derruba as tabelas e, pós-tráfego, o rollback é restore de snapshot.",
    rollback: "drizzle/rollback/0001_to_0000_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0002_rate_limit_database",
    class: "SAFE",
    rationale:
      "Cria a tabela rate_limits e seus grants/índices; nenhum DML sobre dados existentes.",
    evidence: [
      "drizzle/0002_rate_limit_database.sql",
      "scripts/db/test-migrations.ts (replay e grants de rate_limits)",
    ],
    sha256: "d730f0fbb9a54d4a4f09b11526540d6f11fb0d0ea734fa699fc998b2940e8ff6",
    rollback: "drizzle/rollback/0002_to_0001_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0003_curvy_firebrand",
    class: "ONLINE_WITH_CARE",
    rationale:
      "Cria as tabelas P1 e usa ADD COLUMN NOT NULL DEFAULT em products/simulations (metadata-only no PG17) com grants/RLS para as novas tabelas.",
    evidence: [
      "drizzle/0003_curvy_firebrand.sql",
      "scripts/db/test-migrations.ts (colunas P1 e rollback 0003→0002)",
    ],
    sha256: "c524ddbd26ace10b17fcb9fba7a78162f66779874b05f2fdcfc326c42c7e38ec",
    onlineCare:
      "Aplicar fora do pico: os ALTER TABLE pegam ACCESS EXCLUSIVE breve por tabela; o down 0003→0002 remove as tabelas P1 e não preserva dados.",
    rollback: "drizzle/rollback/0003_to_0002_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0004_giant_nocturne",
    class: "DATA_MIGRATION",
    rationale:
      "Expande purchase_price_history (ingredient_id/packaging_id), converte o discriminador legado por UPDATE absoluto e só então adiciona FKs/CHECK; o preflight aborta fail-loud quando há órfão.",
    evidence: [
      "drizzle/0004_giant_nocturne.sql",
      "scripts/db/migrate.ts:25-86 (preflight fail-loud antes do migrator)",
      "scripts/db/test-migrations.ts (assertUpgradeFrom0003: reconciliação e aborto por órfão)",
    ],
    sha256: "1517e6f4684aa87137d16bb6f5e81b18c0bd651210f4a454ecfea8f502258570",
    idempotent: true,
    rollback: "drizzle/rollback/0004_to_0003_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0005_ai_tool_call_count",
    class: "SAFE",
    rationale:
      "Adiciona tool_call_count (NOT NULL DEFAULT 0, metadata-only) e recria o CHECK de ai_daily_budgets com a variante final; sem DML próprio.",
    evidence: [
      "drizzle/0005_ai_tool_call_count.sql",
      "scripts/db/test-migrations.ts (replay do chain)",
    ],
    sha256: "7a6495ce7e9d39ffa368efbab48031e7e2ed7cb71babd064740ca348081d4ead",
    rollback: "drizzle/rollback/0005_to_0004_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0006_loud_lockjaw",
    class: "SAFE",
    rationale:
      "Cria ai_usage e adiciona colunas com default constante em ai_daily_budgets, com grants/RLS para a nova tabela; aditiva, sem DML.",
    evidence: ["drizzle/0006_loud_lockjaw.sql", "scripts/db/test-migrations.ts (replay do chain)"],
    sha256: "51f32b321436a83c666229ea850e9e8fc851b915e7c37774167d81a5508b0dcb",
    rollback: "drizzle/rollback/0006_to_0005_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0007_add_accounts_issuer",
    class: "SAFE",
    rationale:
      "Passo expand do par 0007+0010: adiciona accounts.issuer nullable com IF NOT EXISTS, sem tocar dados existentes.",
    evidence: [
      "drizzle/0007_add_accounts_issuer.sql",
      "docs/runbooks/migration-safety.md (retroativo expand→backfill 0007+0010)",
    ],
    sha256: "db08871dbb49d16be1de994fc1963e26661dced76e768e9488ee031772610e5e",
    idempotent: true,
    rollback: "drizzle/rollback/0007_to_0006_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0008_workable_professor_monster",
    class: "ONLINE_WITH_CARE",
    rationale:
      "Faz DROP NOT NULL em calculation_snapshots.entity_id, adiciona colunas em ai_usage/chat_conversations/tool_executions, recria o CHECK de ai_daily_budgets e cria índice único de idempotência.",
    evidence: [
      "drizzle/0008_workable_professor_monster.sql",
      "drizzle/rollback/0008_to_0007_down.sql",
      "scripts/db/test-migrations.ts (replay do chain)",
    ],
    sha256: "a8ca9a022686b5f1b8fff0aef3725fa2a3f0fa190ee310148a9d2cfa4fcc8e0b",
    onlineCare:
      "Aplicar fora do pico: cada ALTER TABLE pega ACCESS EXCLUSIVE breve; a validação do CHECK recriado escaneia ai_daily_budgets; o DROP NOT NULL não reescreve a tabela.",
    rollback: "drizzle/rollback/0008_to_0007_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0009_military_gertrude_yorkes",
    class: "SAFE",
    rationale:
      "Expand puro: adiciona ai_usage.tool_execution_id uuid nullable, sem constraint, índice ou DML.",
    evidence: [
      "drizzle/0009_military_gertrude_yorkes.sql",
      "scripts/db/test-migrations.ts (replay do chain)",
    ],
    sha256: "e544600a73dc01c4cc32f61c7be12ad67aeb3785272685c77512317af5d6d734",
    rollback: "drizzle/rollback/0009_to_0008_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0010_backfill_accounts_issuer",
    class: "DATA_MIGRATION",
    rationale:
      "Backfill bounded e idempotente: seta issuer='local:credential' apenas onde provider_id='credential' AND issuer IS NULL, sem sobrescrever valor gravado por 1.7.x.",
    evidence: [
      "drizzle/0010_backfill_accounts_issuer.sql",
      "drizzle/rollback/0010_to_0009_down.sql (guarda fail-closed; pós-tráfego o rollback é restore de snapshot)",
      "scripts/db/test-migrations.ts (replay do chain)",
    ],
    sha256: "5bbe63899706fb8be6ef8777b099db1bcdd120fa02fc539ca69ba6e85349b605",
    idempotent: true,
    rollback: "drizzle/rollback/0010_to_0009_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0011_auth_rls_normalization",
    class: "SAFE",
    rationale:
      "Normalização idempotente de RLS: habilita RLS com guards e cria auth_service_access (FOR ALL para app_runtime) nas cinco tabelas de auth; aditiva e sem DML de dados.",
    evidence: [
      "drizzle/0011_auth_rls_normalization.sql",
      "docs/evidence/cp1-auth-rls-2026-09-10/",
      "scripts/db/test-migrations.ts (bloco auth RLS em assertDatabaseContract)",
    ],
    sha256: "6c9d62a66e40edfb53e6f1eb2be1d0195390192ab75ea17af0ac87f897138fef",
    idempotent: true,
    rollback: "drizzle/rollback/0011_to_0010_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0012_youthful_stellaris",
    class: "SAFE",
    rationale:
      "Expand puro: adiciona tool_call_id text, input jsonb e usage_id uuid nullable mais o índice (tenant_id, usage_id) em tool_executions, sem FK, CHECK ou DML.",
    evidence: [
      "drizzle/0012_youthful_stellaris.sql",
      "drizzle/rollback/0012_to_0011_down.sql",
      "scripts/db/test-migrations.ts (replay do chain)",
      "docs/evidence/onda1-tool-execution-2026-09-13.md",
    ],
    sha256: "fc34d49308a814caa351ffd158de7e1797a02bc59b4d3fbc04260d4da1e68dba",
    rollback: "drizzle/rollback/0012_to_0011_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0013_robust_cammi",
    class: "ONLINE_WITH_CARE",
    rationale:
      "Adiciona version integer NOT NULL DEFAULT 0 e CHECK (version >= 0) em products e expenses (T2/CAS otimista); o ALTER ADD COLUMN é metadata-only no PG17, mas a validação do CHECK varre cada tabela.",
    evidence: [
      "drizzle/0013_robust_cammi.sql",
      "drizzle/rollback/0013_to_0012_down.sql",
      "scripts/db/test-migrations.ts (replay do chain e colunas version)",
      "scripts/db/test-concurrency.ts (CAS 1 OK + 1 CONFLICT + incremento)",
      "docs/adr/ADR-029-concurrency-t2-optimistic-version.md",
      "docs/evidence/onda1-t2-bff-2026-09-13.md",
    ],
    sha256: "f974d0b255ef2797844ed0c50c56ce59eacf6d2559509ccf5840ab76df119bf2",
    onlineCare:
      "Aplicar fora do pico: cada ALTER TABLE pega ACCESS EXCLUSIVE breve por tabela; a validação do CHECK version >= 0 escaneia products e expenses uma vez. O down remove constraint e coluna sem preservar o contador.",
    rollback: "drizzle/rollback/0013_to_0012_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0014_mighty_veda",
    class: "SAFE",
    rationale:
      "Cria a série append-only rum_vitals, o índice (name, received_at) e os grants (INSERT-only para app_runtime); sem tenant_id, sem RLS por design e sem DML.",
    evidence: [
      "drizzle/0014_mighty_veda.sql",
      "drizzle/rollback/0014_to_0013_down.sql",
      "scripts/db/test-rum-persistence.ts (insert best-effort e grants da série)",
      "docs/evidence/rum-persistence-2026-09-13.md",
    ],
    sha256: "069b97ae9f1658708d2a85d08c3b36fa36c988d217860c2c135230f1ae34c3f2",
    rollback: "drizzle/rollback/0014_to_0013_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0015_curved_riptide",
    class: "SAFE",
    rationale:
      "Cria as tabelas outbox_events e outbox_consumptions com índices, CHECKs e grants/RLS para app_runtime; aditiva, sem DML e sem alterar objetos pré-existentes.",
    evidence: [
      "drizzle/0015_curved_riptide.sql",
      "drizzle/rollback/0015_to_0014_down.sql",
      "scripts/db/test-outbox.ts (T1 atomicidade, T5 RLS/grants e isolamento de tenant)",
      "docs/specs/M-04/spec.md:231-254 (contrato e requisitos de grants/RLS do outbox)",
      "docs/evidence/agent-state/SPEC-CARDS/23-outbox.md",
    ],
    sha256: "c91c648921990b5d30eea3040b51ce09c3ffb9e4d36423168931817b0e3968cb",
    rollback: "drizzle/rollback/0015_to_0014_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0016_slim_imperial_guard",
    class: "SAFE",
    rationale:
      "Cria as tabelas do ledger de backfill (backfill_checkpoints e backfill_work_items) com PKs compostas por tenant, CHECKs, índice e grants/RLS para app_runtime; aditiva, sem DML e sem alterar objetos pré-existentes.",
    evidence: [
      "drizzle/0016_slim_imperial_guard.sql",
      "drizzle/rollback/0016_to_0015_down.sql",
      "scripts/db/test-backfill.ts (T1 SIGKILL+retomada, T2 contenção CAS, T3 22012, T4 idempotência, T5 RLS/grants)",
      "src/db/schema.ts (backfillCheckpoints/backfillWorkItems)",
      "docs/evidence/agent-state/SPEC-CARDS/WP-1a-backfill-ledger.md",
    ],
    sha256: "46b57f880467a9df7cb2a93a3fed6d931c34c8c3793fa5a718b81dc564708be7",
    rollback: "drizzle/rollback/0016_to_0015_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0017_past_gideon",
    class: "SAFE",
    rationale:
      "Cria a persistência da memória (ai_memories + ai_memory_sources 1:N) com FK composta de tenant, CHECKs de faixa/conteúdo, índices e grants/RLS para app_runtime; aditiva, sem DML e sem alterar objetos pré-existentes.",
    evidence: [
      "drizzle/0017_past_gideon.sql",
      "drizzle/rollback/0017_to_0016_down.sql",
      "scripts/db/test-memory.ts (T1 isolamento de tenant + WITH CHECK, T2 proveniência/FK/CHECK, T3 atomicidade com efeito de domínio, T4 delete/cascata/grants, T5 classificação)",
      "src/db/schema.ts (aiMemories/aiMemorySources)",
      "docs/evidence/agent-state/SPEC-CARDS/CICLO-2.md (§MEM-D2)",
    ],
    sha256: "ba66a3f37a238bb1ff9b6cc7b658fa746b076aec2d41bc76d5d92b99078c2c90",
    rollback: "drizzle/rollback/0017_to_0016_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0018_polite_living_tribunal",
    class: "SAFE",
    rationale:
      "Dedup/versionamento/conflitos da memória (§15.6/D3): cria ai_memory_versions e ai_memory_conflicts com FK composta RESTRICT, CHECKs e índices, adiciona ai_memories.dedup_key NOT NULL (tabela sem escritor antes de D3) com índice único parcial e concede grants/RLS mínimos; aditiva, sem DML e sem alterar objetos pré-existentes.",
    evidence: [
      "drizzle/0018_polite_living_tribunal.sql",
      "drizzle/rollback/0018_to_0017_down.sql",
      "scripts/db/test-memory.ts (D3/T1 dedup idempotente, T2 revisão/versão byte a byte, T3 conflito sem sobrescrever o ativo, T4 delete × expurgo, T5 concorrência de 2 sessões no índice único, T6 isolamento de tenant, T7 imutabilidade por privilégio, T8 classificação)",
      "src/db/schema.ts (aiMemoryVersions/aiMemoryConflicts + ai_memories.dedupKey)",
      "docs/evidence/agent-state/SPEC-CARDS/CICLO-3.md (§WP-D3, SD-C3-1…SD-C3-11)",
    ],
    sha256: "4cdeecf7a61efeba31d0ee9e1f3d04a1a5dfe1a03f22b9b403738cf41de4176a",
    rollback: "drizzle/rollback/0018_to_0017_down.sql",
    appliedOn: "empty",
  },
  {
    tag: "0019_tiresome_robin_chapel",
    class: "ONLINE_WITH_CARE",
    rationale:
      "Degrau D4 (§43/§15.4 + H-12): cria ai_memory_access_log e ai_memory_policies, adiciona ai_memories.layer NOT NULL DEFAULT 'L2' + expires_at, troca o CHECK de status para incluir 'expired' (vocabulário do Apêndice C), concede DELETE a app_runtime em ai_memory_versions/ai_memory_conflicts (SD-C3-12) e semeia as 5 políticas de retenção versionadas (§H-12 opção A).",
    evidence: [
      "drizzle/0019_tiresome_robin_chapel.sql",
      "drizzle/rollback/0019_to_0018_down.sql",
      "scripts/db/test-memory.ts (D4/T1 export por tenant com fontes+versões e AUTHORIZATION_ERROR sem has_tenant_access, D4/T2 auditoria do access log + autorização por escopo, D4/T3 TTL por camada com expiração idempotente, D4/T4 migration com dados (up→down→up da 0019), D4/T5 classificação, D4/T6 grants/RLS do log e das policies + DELETE do expurgo)",
      "src/db/schema.ts (aiMemoryAccessLog/aiMemoryPolicies + ai_memories.layer/expiresAt)",
      "docs/evidence/agent-state/DECISIONS-PENDING/H-12.md (TTL L1–L5 aprovado + escopo do export)",
      "docs/evidence/agent-state/SPEC-DELTAS/DECISOES-STEWARD-CICLO-3-POS-E1.md (SD-C3-12)",
      "docs/evidence/trk-b-mem-d4-2026-09-17/",
    ],
    sha256: "9d81a7857157191a289b41d798684631434504ebde3e09f30711f83aeb44d663",
    idempotent: true,
    rollback: "drizzle/rollback/0019_to_0018_down.sql",
    appliedOn: "empty",
    onlineCare:
      "Aplicar fora do pico: os dois ALTER TABLE de ai_memories pegam ACCESS EXCLUSIVE breve (o ADD COLUMN com default constante é metadata-only no PG17, mas a validação do CHECK de status e do CHECK de layer escaneia a tabela) e o seed de políticas é INSERT idempotente de 5 linhas. A tabela de memória não tem escritor em produção (feature não exposta), então o escaneamento incide sobre 0 linhas; o down é executável com dados (coluna com default + seed idempotente).",
  },
];
