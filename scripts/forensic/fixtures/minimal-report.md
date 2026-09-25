# FINAL-REPORT — fixture mínimo do schema v2

Este fixture é estrutural: não afirma que um snapshot foi executado nem que o
escopo Git foi recomputado. Os valores de commit são sintaticamente válidos e
servem apenas para exercitar o contrato; os testes de escopo usam um repositório
temporário com SHAs reais.

```yaml
forensic_sdd_report:
  version: 2
  mode: INVESTIGATIVE_FORENSIC
  session_id: CHK-2026-08-29-1200
  date: "2026-08-29"
  session_state: WAITING_ON_ENVIRONMENT
  previous_session: null
  repository:
    path: /home/douglas-souza/preco-que-d-main
    branch_expected: program/v5-fechamento-sdd
    branch_observed: program/v5-fechamento-sdd
    branch_match: true
    head_expected: 233ad6c28f0f2f5a543524ee174efc39f5a6d62e
    head_observed: 233ad6c28f0f2f5a543524ee174efc39f5a6d62e
    head_match: true
    worktree:
      status: DIRTY
      modified:
        - EXECUTION-STATE-PROGRAM.md
      untracked:
        - .pi/
        - PLANO_OTIMIZADO_AUTENTICACAO_E_RETOMADA.md
    tracking:
      ahead: 18
      behind: 0
      remote_equivalence: UNVERIFIED
  governance:
    owners:
      infrastructure: "Owner Infra"
      rat_m02: "Owner RAT"
      governance: "Owner Gov"
    sla:
      hours: 48
      waiting_since: "2026-08-29T12:00:00-03:00"
      expired: false
  preservation:
    snapshot:
      performed: false
      verified: false
  drift_since_last_session:
    classification: NONE
    items: []
  expected_scope:
    computed: false
    base: a311fac509cf9581f089263f933b8097792b09a9
    head: 233ad6c28f0f2f5a543524ee174efc39f5a6d62e
    file_count: 0
    sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  layers:
    L1_documental:
      status: RECONCILED_WITH_GAPS
    L2_architecture:
      status: DRAFT_PENDING_DEFERRED_EXTRACTION
    L3_security:
      status: BLOCKED
    L4_platform:
      status: BLOCKED_ROOT_CAUSE_NOT_DETERMINED
    L5_git:
      status: LOCAL_VERIFIED
    L6_tests:
      status: HISTORICAL_EVIDENCE_ONLY
    L7_data:
      status: STATIC_SCHEMA_VERIFIED_RUNTIME_UNKNOWN
    L8_synthesis:
      status: WAITING_ON_ENVIRONMENT
  subagents:
    - id: F1-DOC-GIT
      status: COMPLETE
      scope: L1+L5
    - id: F2-M02-DATA
      status: COMPLETE
      scope: L2+L7
    - id: F3-SEC-PLATFORM
      status: COMPLETE
      scope: L3+L4
    - id: F4-TEST-SYNTH
      status: COMPLETE
      scope: L6+L8
  m02: PENDING_DEFERRED_EXTRACTION
  gates_consumed: []
  product_verdict: NO-VERDICT
  release_or_p8: DO_NOT_ADVANCE
  proof_a:
    a1:
      status: PENDING_BLOCKED
    a2:
      status: PENDING_BLOCKED
    a3:
      status: PENDING_BLOCKED
    overall: PENDING_BLOCKED
    evidence_index: []
  proof_b:
    checks:
      same_scanid_or_resolution: false
      running_false: false
      sealed_true: false
      report_available: false
      findings_counted: false
      range_exact: false
      scope_matches: false
    scope_diff:
      missing: []
      extra: []
    overall: PENDING_BLOCKED
  erratum:
    ledger_append_only_deletion: PENDING
  final_state:
    state: WAITING_ON_ENVIRONMENT
    product_verdict: NO-VERDICT
    m02: PENDING_DEFERRED_EXTRACTION
    gates_consumed: []
    release_or_p8: DO_NOT_ADVANCE
    resume_condition: "Provas A e B válidas e reconciliadas"
ledger_record:
  record_id: FORENSIC-CHK-2026-08-29-1200
  persistence: RESPONSE_ONLY_NOT_WRITTEN
  append_mode: APPEND_ONLY
  mode: INVESTIGATIVE_FORENSIC
  session_id: CHK-2026-08-29-1200
  head: 233ad6c28f0f2f5a543524ee174efc39f5a6d62e
  product_verdict: NO-VERDICT
  gates_consumed: []
  release_or_p8: DO_NOT_ADVANCE
  repository: /home/douglas-souza/preco-que-d-main
  branch: program/v5-fechamento-sdd
```
