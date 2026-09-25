#!/usr/bin/env python3
"""Contract tests for the current forensic SDD report validator.

The production validator and schema are intentionally treated as read-only
fixtures.  Tests create all reports, evidence, manifests, and Git repositories
under temporary directories so this suite cannot modify the checkout's
existing forensic artifacts or dirty files.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
FORENSIC_DIR = REPO_ROOT / "scripts" / "forensic"
CLI_PATH = FORENSIC_DIR / "forensic_validate.py"
SCHEMA_PATH = FORENSIC_DIR / "forensic-report-v2.schema.json"
WRAPPER_PATH = FORENSIC_DIR / "verify-forensic-session.sh"


def _load_validator_module() -> Any:
    spec = importlib.util.spec_from_file_location(
        "forensic_validate_under_test", CLI_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load validator module from {CLI_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except SystemExit as exc:
        if exc.code == 2:
            raise unittest.SkipTest(
                "forensic validator dependencies are unavailable"
            ) from exc
        raise
    return module


validator = _load_validator_module()
SCHEMA = validator._load_schema(SCHEMA_PATH)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _git_sha(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


GIT_HEAD_A = _git_sha("forensic-test-head-a")
GIT_HEAD_B = _git_sha("forensic-test-head-b")
GIT_HEAD_C = _git_sha("forensic-test-head-c")
HASH_A = _sha256_bytes(b"forensic-test-hash-a")
HASH_B = _sha256_bytes(b"forensic-test-hash-b")
HASH_C = _sha256_bytes(b"forensic-test-hash-c")
SESSION_PATTERN = re.compile(
    r"^(?:CHK|GENESIS)-(?P<day>[0-9]{4}-[0-9]{2}-[0-9]{2})(?:-[0-9]{4})?$"
)


def _session_day(session_id: str) -> str:
    match = SESSION_PATTERN.fullmatch(session_id)
    if match is None:
        raise ValueError(f"unsupported test session id: {session_id}")
    return match.group("day")


def _markdown_documents(*documents: dict[str, Any]) -> str:
    blocks = []
    for document in documents:
        blocks.append(
            "```yaml\n"
            + json.dumps(document, indent=2, ensure_ascii=False, sort_keys=False)
            + "\n```"
        )
    return "\n\n".join(blocks) + "\n"


def _write_report(path: Path, *documents: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_markdown_documents(*documents), encoding="utf-8")


def _base_report(
    *,
    session_id: str = "CHK-2026-08-29-1200",
    session_state: str = "VERDICT",
    previous_session: dict[str, Any] | None = None,
    repository_head: str = GIT_HEAD_A,
    product_verdict: str = "NO-VERDICT",
    release_or_p8: str = "DO_NOT_ADVANCE",
    gates_consumed: list[str] | None = None,
    proof_a_overall: str = "PENDING_BLOCKED",
    proof_b_overall: str = "PENDING_BLOCKED",
    evidence_index: list[dict[str, Any]] | None = None,
    waiting_since: str = "2026-08-29T10:00:00+00:00",
    drift: dict[str, Any] | None = None,
    repository_path: str | None = None,
) -> dict[str, Any]:
    """Return a schema-valid, semantically consistent baseline report."""
    gates = list(gates_consumed or [])
    report: dict[str, Any] = {
        "version": 2,
        "mode": "INVESTIGATIVE_FORENSIC",
        "session_id": session_id,
        "date": _session_day(session_id),
        "session_state": session_state,
        "previous_session": copy.deepcopy(previous_session),
        "repository": {
            "path": repository_path or str(REPO_ROOT),
            "branch_expected": "develop",
            "branch_observed": "develop",
            "branch_match": True,
            "head_expected": repository_head,
            "head_observed": repository_head,
            "head_match": True,
            "worktree": {
                "status": "CLEAN",
                "modified": [],
                "untracked": [],
            },
            "tracking": {
                "ahead": 0,
                "behind": 0,
                "remote_equivalence": "UNVERIFIED",
            },
        },
        "governance": {
            "owners": {
                "infrastructure": "infra-owner",
                "rat_m02": "rat-owner",
                "governance": "governance-owner",
            },
            "sla": {
                "hours": 24,
                "waiting_since": waiting_since,
                "expired": False,
                "last_review": "2026-08-29T11:00:00+00:00",
            },
            "escalations": [],
        },
        "preservation": {
            "snapshot": {
                "performed": False,
                "verified": False,
                "files": 0,
            }
        },
        "drift_since_last_session": drift
        or {
            "classification": "NONE",
            "items": [],
        },
        "expected_scope": {
            "computed": False,
            "base": _git_sha("forensic-test-scope-base"),
            "head": _git_sha("forensic-test-scope-head"),
            "file_count": 0,
            "sha256": _sha256_bytes(b"forensic-test-scope"),
        },
        "layers": {
            layer: {"status": "NOT_RUN", "findings": []}
            for layer in (
                "L1_documental",
                "L2_architecture",
                "L3_security",
                "L4_platform",
                "L5_git",
                "L6_tests",
                "L7_data",
                "L8_synthesis",
            )
        },
        "subagents": [
            {
                "id": "F1-DOC-GIT",
                "status": "PARTIAL",
                "scope": "documentation and Git evidence",
            },
            {
                "id": "F2-M02-DATA",
                "status": "PARTIAL",
                "scope": "M-02 data",
            },
            {
                "id": "F3-SEC-PLATFORM",
                "status": "PARTIAL",
                "scope": "security and platform",
            },
            {
                "id": "F4-TEST-SYNTH",
                "status": "PARTIAL",
                "scope": "test synthesis",
            },
        ],
        "m02": "PENDING_DEFERRED_EXTRACTION",
        "gates_consumed": gates,
        "product_verdict": product_verdict,
        "release_or_p8": release_or_p8,
        "proof_a": {
            "a1": {"status": "PENDING_BLOCKED", "notes": "awaiting evidence"},
            "a2": {"status": "PENDING_BLOCKED", "notes": "awaiting evidence"},
            "a3": {"status": "PENDING_BLOCKED", "notes": "awaiting evidence"},
            "overall": proof_a_overall,
            "evidence_index": copy.deepcopy(evidence_index or []),
        },
        "proof_b": {
            "checks": {
                "same_scanid_or_resolution": False,
                "running_false": False,
                "sealed_true": False,
                "report_available": False,
                "findings_counted": False,
                "range_exact": False,
                "scope_matches": False,
            },
            "scope_diff": {"missing": [], "extra": []},
            "overall": proof_b_overall,
        },
        "final_state": {
            "state": session_state,
            "product_verdict": product_verdict,
            "m02": "PENDING_DEFERRED_EXTRACTION",
            "gates_consumed": gates,
            "release_or_p8": release_or_p8,
            "resume_condition": "continue after the next authorized checkpoint",
        },
    }
    if gates:
        report["gates_authorization"] = {
            "by": "authorized-owner",
            "date": _session_day(session_id),
            "scope": "test gate authorization",
        }
    if session_state == "ESCALATION_INCIDENT":
        report["escalation"] = {
            "active": True,
            "severity": "SEV2",
            "owner": "incident-owner",
            "reason": "test incident requires controlled escalation",
        }
    return report


def _passing_report(report: dict[str, Any]) -> dict[str, Any]:
    report = copy.deepcopy(report)
    report["product_verdict"] = "PASS"
    report["release_or_p8"] = "ADVANCE_RECOMMENDED"
    report["expected_scope"]["computed"] = True
    report["proof_a"]["evidence_index"] = [
        {
            "item": "passing proof fixture",
            "path": "proof-a/passing-proof.txt",
            "sha256": HASH_A,
        }
    ]
    for key in ("a1", "a2", "a3"):
        report["proof_a"][key]["status"] = "PASS"
    report["proof_a"]["overall"] = "PASS"
    report["proof_b"]["overall"] = "PASS"
    report["proof_b"]["checks"] = {
        "same_scanid_or_resolution": True,
        "running_false": True,
        "sealed_true": True,
        "report_available": True,
        "findings_counted": True,
        "range_exact": True,
        "scope_matches": True,
    }
    report["final_state"]["product_verdict"] = "PASS"
    report["final_state"]["release_or_p8"] = "ADVANCE_RECOMMENDED"
    return report


def _proof_validation_for(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "proof_validation_report": {
            "proof_a": {"overall": report["proof_a"]["overall"]},
            "proof_b": {"overall": report["proof_b"]["overall"]},
            "product_verdict": report["product_verdict"],
            "p8_recommendation": report["release_or_p8"],
        }
    }


def _ledger_for(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "ledger_record": {
            "record_id": "LEDGER-TEST-001",
            "persistence": "RESPONSE_ONLY_NOT_WRITTEN",
            "session_id": report["session_id"],
            "head": report["repository"]["head_observed"],
            "product_verdict": report["product_verdict"],
            "gates_consumed": copy.deepcopy(report["gates_consumed"]),
            "release_or_p8": report["release_or_p8"],
        }
    }


def _document(
    report: dict[str, Any],
    *,
    ledger: dict[str, Any] | None = None,
    proof_validation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    document: dict[str, Any] = {"forensic_sdd_report": copy.deepcopy(report)}
    if ledger is not None:
        document.update(copy.deepcopy(ledger))
    if proof_validation is not None:
        document.update(copy.deepcopy(proof_validation))
    return document


def _run_cli(
    *args: object, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(CLI_PATH), *(str(arg) for arg in args)]
    process_env = os.environ.copy()
    if env:
        process_env.update(env)
    return subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=process_env,
        capture_output=True,
        text=True,
        check=False,
    )


def _run_git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _make_git_repo(root: Path) -> tuple[Path, str, str, list[str], str]:
    repo = root / "scope-repo"
    repo.mkdir()
    _run_git(repo, "init", "--quiet")
    _run_git(repo, "config", "user.email", "forensic-tests@example.invalid")
    _run_git(repo, "config", "user.name", "Forensic Tests")
    (repo / "first.txt").write_text("first\n", encoding="utf-8")
    _run_git(repo, "add", "first.txt")
    _run_git(repo, "commit", "--quiet", "-m", "first")
    base = _run_git(repo, "rev-parse", "HEAD")
    (repo / "second.txt").write_text("second\n", encoding="utf-8")
    _run_git(repo, "add", "second.txt")
    _run_git(repo, "commit", "--quiet", "-m", "second")
    head = _run_git(repo, "rev-parse", "HEAD")
    paths, scope_hash = validator._git_scope(repo, base, head)
    return repo, base, head, paths, scope_hash


def _make_genesis(
    root: Path, session_id: str = "GENESIS-2026-08-28"
) -> tuple[Path, Path]:
    session = root / session_id
    report_path = session / "FINAL-REPORT.md"
    _write_report(report_path, {"forensic_sdd_report": {"session_id": session_id}})
    return session, report_path


def _make_checkpoint(
    root: Path,
    session_id: str,
    *,
    previous: Path | None = None,
    **report_kwargs: Any,
) -> tuple[Path, Path, dict[str, Any]]:
    previous_session = None
    if previous is not None:
        previous_report = previous / "FINAL-REPORT.md"
        previous_session = {
            "id": previous.name,
            "final_report_sha256": validator.sha256_file(previous_report),
        }
    report = _base_report(
        session_id=session_id,
        previous_session=previous_session,
        **report_kwargs,
    )
    session = root / session_id
    report_path = session / "FINAL-REPORT.md"
    _write_report(report_path, {"forensic_sdd_report": report})
    return session, report_path, report


class ForensicValidatorTests(unittest.TestCase):
    def assert_errors(
        self, document: dict[str, Any], fragment: str | None = None
    ) -> list[str]:
        errors = validator.validate(document, SCHEMA)
        self.assertTrue(errors, "expected validation errors")
        if fragment is not None:
            self.assertTrue(
                any(fragment.lower() in error.lower() for error in errors),
                f"{fragment!r} not found in errors: {errors}",
            )
        return errors

    def test_minimal_structurally_valid_report_passes_schema_and_semantics(
        self,
    ) -> None:
        report = _base_report()
        self.assertEqual([], validator.validate(_document(report), SCHEMA))

    def test_complete_passing_report_requires_and_satisfies_both_proofs(self) -> None:
        report = _passing_report(_base_report())
        document = _document(report, proof_validation=_proof_validation_for(report))
        self.assertEqual([], validator.validate(document, SCHEMA))

    def test_product_pass_requires_both_proofs_to_be_pass(self) -> None:
        report = _base_report(product_verdict="PASS")
        self.assert_errors(_document(report), "proof_a.overall")
        self.assert_errors(_document(report), "proof_b.overall")

    def test_approval_requires_computed_scope_and_nonempty_proof_evidence(self) -> None:
        report = _base_report(product_verdict="PASS")
        report["release_or_p8"] = "DO_NOT_ADVANCE"
        report["final_state"]["product_verdict"] = "PASS"
        report["final_state"]["release_or_p8"] = "DO_NOT_ADVANCE"
        for key in ("a1", "a2", "a3"):
            report["proof_a"][key]["status"] = "PASS"
        report["proof_a"]["overall"] = "PASS"
        report["proof_b"]["overall"] = "PASS"
        report["proof_b"]["checks"] = {
            "same_scanid_or_resolution": True,
            "running_false": True,
            "sealed_true": True,
            "report_available": True,
            "findings_counted": True,
            "range_exact": True,
            "scope_matches": True,
        }
        errors = self.assert_errors(_document(report))
        self.assertTrue(any("expected_scope" in error for error in errors))
        self.assertTrue(any("evidence_index" in error for error in errors))

    def test_proof_a_pass_requires_all_subproofs_to_be_pass(self) -> None:
        report = _base_report(proof_a_overall="PASS")
        report["proof_a"]["a1"]["status"] = "PASS"
        report["proof_a"]["a2"]["status"] = "PASS"
        self.assert_errors(_document(report), "a3.status")

    def test_proof_b_pass_requires_all_seven_checks_to_be_true(self) -> None:
        report = _base_report(proof_b_overall="PASS")
        report["proof_b"]["checks"]["scope_matches"] = True
        self.assert_errors(_document(report), "same_scanid_or_resolution")

    def test_rejected_proof_requires_a_reason(self) -> None:
        report = _base_report(proof_a_overall="REJECTED")
        self.assert_errors(_document(report), "rejection_reason")

    def test_waiting_state_requires_infrastructure_owner_and_sla(self) -> None:
        report = _base_report(session_state="WAITING_ON_ENVIRONMENT")
        report["governance"].pop("owners")
        self.assert_errors(_document(report), "owners")

        report = _base_report(session_state="WAITING_ON_ENVIRONMENT")
        report["governance"].pop("sla")
        self.assert_errors(_document(report), "sla")

    def test_escalation_incident_requires_active_escalation_details(self) -> None:
        report = _base_report(session_state="ESCALATION_INCIDENT")
        report.pop("escalation")
        self.assert_errors(_document(report), "escalation")

        report = _base_report(session_state="ESCALATION_INCIDENT")
        report["escalation"]["active"] = False
        self.assert_errors(_document(report), "active")

    def test_consumed_gate_requires_authorization(self) -> None:
        report = _base_report(gates_consumed=["GATE-TEST"])
        report.pop("gates_authorization")
        self.assert_errors(_document(report), "gates_authorization")

    def test_unexpected_or_mixed_drift_requires_action(self) -> None:
        for classification in ("UNEXPECTED", "MIXED"):
            report = _base_report(drift={"classification": classification, "items": []})
            self.assert_errors(_document(report), "action_taken")

    def test_performed_snapshot_requires_destination_archive_hash_and_verification(
        self,
    ) -> None:
        report = _base_report()
        report["preservation"]["snapshot"] = {"performed": True}
        errors = self.assert_errors(_document(report))
        self.assertTrue(any("archive_sha256" in error for error in errors))
        self.assertTrue(any("destination" in error for error in errors))

    def test_schema_rejects_unknown_root_and_nested_properties(self) -> None:
        mutations: list[tuple[str, Callable[[dict[str, Any]], None]]] = [
            ("root", lambda document: document.update({"unexpected": True})),
            (
                "report",
                lambda document: document["forensic_sdd_report"].update(
                    {"unexpected": True}
                ),
            ),
            (
                "layer",
                lambda document: document["forensic_sdd_report"]["layers"][
                    "L1_documental"
                ].update({"unexpected": True}),
            ),
            (
                "proof_a",
                lambda document: document["forensic_sdd_report"]["proof_a"].update(
                    {"unexpected": True}
                ),
            ),
            (
                "proof_b_checks",
                lambda document: document["forensic_sdd_report"]["proof_b"][
                    "checks"
                ].update({"unexpected": True}),
            ),
            (
                "final_state",
                lambda document: document["forensic_sdd_report"]["final_state"].update(
                    {"unexpected": True}
                ),
            ),
        ]
        for label, mutate in mutations:
            with self.subTest(location=label):
                document = _document(_base_report())
                mutate(document)
                self.assert_errors(document, "additional properties")

        document = _document(
            _base_report(),
            ledger=_ledger_for(_base_report()),
            proof_validation=_proof_validation_for(_base_report()),
        )
        document["ledger_record"]["unexpected"] = True
        self.assert_errors(document, "additional properties")

        document = _document(
            _base_report(), proof_validation=_proof_validation_for(_base_report())
        )
        document["proof_validation_report"]["unexpected"] = True
        self.assert_errors(document, "additional properties")

    def test_parser_rejects_duplicate_yaml_mapping_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-parser-") as directory:
            report_path = Path(directory) / "FINAL-REPORT.md"
            report_path.write_text(
                "```yaml\nforensic_sdd_report:\n  version: 2\n  version: 2\n```\n",
                encoding="utf-8",
            )
            with self.assertRaises(validator.ExtractionError):
                validator.load_documents(report_path)

    def test_parser_rejects_duplicate_top_level_documents_without_overwrite(
        self,
    ) -> None:
        report = _base_report()
        with tempfile.TemporaryDirectory(prefix="forensic-parser-") as directory:
            report_path = Path(directory) / "FINAL-REPORT.md"
            _write_report(
                report_path,
                {"forensic_sdd_report": report},
                {"forensic_sdd_report": report},
            )
            with self.assertRaises(validator.ExtractionError):
                validator.load_documents(report_path)

    def test_parser_retains_unknown_top_level_key_for_strict_schema_failure(
        self,
    ) -> None:
        report = _base_report()
        document = _document(report)
        document["unknown_document"] = {"value": True}
        with tempfile.TemporaryDirectory(prefix="forensic-parser-") as directory:
            report_path = Path(directory) / "FINAL-REPORT.md"
            _write_report(report_path, document)
            loaded = validator.load_documents(report_path)
            self.assertIn("unknown_document", loaded)
            self.assert_errors(loaded, "additional properties")

    def test_calendar_date_and_session_id_are_checked_beyond_regex(self) -> None:
        report = _base_report(
            session_id="CHK-2026-02-31-1200",
        )
        self.assert_errors(_document(report), "invalid calendar")

        report = _base_report()
        report["date"] = "2026-08-30"
        self.assert_errors(_document(report), "must match the date")

    def test_datetime_without_explicit_timezone_is_rejected(self) -> None:
        report = _base_report()
        report["governance"]["sla"]["waiting_since"] = "2026-08-29T10:00:00"
        self.assert_errors(_document(report), "waiting_since")

    def test_subagent_ids_must_each_occur_exactly_once(self) -> None:
        report = _base_report()
        report["subagents"][1]["id"] = report["subagents"][0]["id"]
        self.assert_errors(_document(report), "subagents")

    def test_final_state_and_ledger_must_mirror_report(self) -> None:
        report = _base_report()
        document = _document(report, ledger=_ledger_for(report))
        self.assertEqual([], validator.validate(document, SCHEMA))

        document["forensic_sdd_report"]["final_state"]["state"] = "CHECKPOINT_RUNNING"
        document["ledger_record"]["head"] = GIT_HEAD_B
        errors = self.assert_errors(document)
        self.assertTrue(any("final_state.state" in error for error in errors))
        self.assertTrue(any("ledger_record.head" in error for error in errors))

    def test_proof_validation_is_required_and_must_mirror_report(self) -> None:
        report = _base_report(session_state="PROOF_VALIDATION")
        document = _document(report, proof_validation=_proof_validation_for(report))
        self.assertEqual([], validator.validate(document, SCHEMA))

        missing = _document(report)
        self.assert_errors(missing, "proof_validation_report")

        complete = _passing_report(_base_report(session_state="PROOF_VALIDATION"))
        document = _document(complete, proof_validation=_proof_validation_for(complete))
        document["proof_validation_report"]["p8_recommendation"] = "DO_NOT_ADVANCE"
        self.assert_errors(document, "p8_recommendation")

    def test_advance_recommendation_requires_passed_proofs_and_positive_fixture_is_valid(
        self,
    ) -> None:
        report = _base_report(release_or_p8="ADVANCE_RECOMMENDED")
        self.assert_errors(_document(report), "product_verdict")

        complete = _passing_report(_base_report())
        document = _document(complete, proof_validation=_proof_validation_for(complete))
        self.assertEqual([], validator.validate(document, SCHEMA))

    def test_public_report_cli_has_pass_fail_and_environment_boundaries(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-cli-") as directory:
            root = Path(directory)
            valid_path = root / "valid.md"
            _write_report(valid_path, _document(_base_report()))
            valid = _run_cli("report", SCHEMA_PATH, valid_path)
            self.assertEqual(0, valid.returncode, valid.stderr)
            self.assertIn("RESULTADO: SCHEMA_PASS", valid.stdout)

            invalid_path = root / "invalid.md"
            invalid_document = _document(_base_report())
            invalid_document["forensic_sdd_report"]["unexpected"] = True
            _write_report(invalid_path, invalid_document)
            invalid = _run_cli("report", SCHEMA_PATH, invalid_path)
            self.assertEqual(1, invalid.returncode, invalid.stderr)
            self.assertIn("SCHEMA_FAIL", invalid.stdout)

            empty_path = root / "empty.md"
            empty_path.write_text("no forensic document\n", encoding="utf-8")
            extraction = _run_cli("report", SCHEMA_PATH, empty_path)
            self.assertEqual(2, extraction.returncode)
            self.assertIn("EXTRACTION_FAIL", extraction.stderr)

            missing_schema = _run_cli(
                "report", root / "missing-schema.json", valid_path
            )
            self.assertEqual(2, missing_schema.returncode)
            self.assertIn("ENVIRONMENT_FAIL", missing_schema.stderr)

    def test_evidence_hash_is_verified_and_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-evidence-") as directory:
            root = Path(directory)
            session = root / "CHK-2026-08-29-1200"
            evidence = root / "proof-a" / "evidence.txt"
            evidence.parent.mkdir(parents=True)
            evidence.write_bytes(b"evidence payload\n")
            item = {
                "item": "test evidence",
                "path": "proof-a/evidence.txt",
                "sha256": validator.sha256_file(evidence),
            }
            report = _base_report(evidence_index=[item])
            _write_report(session / "FINAL-REPORT.md", _document(report))
            self.assertEqual([], validator.audit_session(session, root))

            report["proof_a"]["evidence_index"][0]["sha256"] = HASH_A
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("SHA-256 mismatch" in error for error in errors))

            report["proof_a"]["evidence_index"][0]["path"] = "missing.txt"
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("missing or not regular" in error for error in errors))

    def test_evidence_audit_rejects_structurally_invalid_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-evidence-") as directory:
            root = Path(directory)
            evidence = root / "evidence.txt"
            evidence.write_bytes(b"evidence payload\n")
            report = _base_report(
                evidence_index=[
                    {
                        "item": "test evidence",
                        "path": "evidence.txt",
                        "sha256": validator.sha256_file(evidence),
                    }
                ]
            )
            report["unexpected"] = True
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("report validation" in error for error in errors))

            report.pop("unexpected")
            mismatched = root / "CHK-2026-08-29-1300"
            _write_report(mismatched / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(mismatched, root)
            self.assertTrue(
                any("does not match session directory" in error for error in errors)
            )

    def test_evidence_paths_reject_traversal_absolute_paths_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-evidence-") as directory:
            root = Path(directory)
            session = root / "CHK-2026-08-29-1200"
            outside = root.parent / f"forensic-outside-{os.getpid()}"
            outside.write_bytes(b"outside\n")
            self.addCleanup(lambda: outside.unlink(missing_ok=True))

            paths = ["../forensic-outside", str(outside)]
            for relative_path in paths:
                with self.subTest(path=relative_path):
                    report = _base_report(
                        evidence_index=[
                            {
                                "item": "unsafe",
                                "path": relative_path,
                                "sha256": validator.sha256_file(outside),
                            }
                        ]
                    )
                    _write_report(session / "FINAL-REPORT.md", _document(report))
                    errors = validator.audit_session(session, root)
                    self.assertTrue(errors)
                    self.assertTrue(
                        any("relative to root" in error for error in errors)
                    )

            symlink = root / "linked-evidence.txt"
            try:
                symlink.symlink_to(outside)
            except OSError as exc:
                self.skipTest(f"symlinks unavailable: {exc}")
            report = _base_report(
                evidence_index=[
                    {
                        "item": "symlink",
                        "path": "linked-evidence.txt",
                        "sha256": validator.sha256_file(outside),
                    }
                ]
            )
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("symlink" in error for error in errors))

    def test_duplicate_evidence_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-evidence-") as directory:
            root = Path(directory)
            evidence = root / "evidence.txt"
            evidence.write_bytes(b"same evidence\n")
            evidence_item = {
                "item": "same",
                "path": "evidence.txt",
                "sha256": validator.sha256_file(evidence),
            }
            report = _base_report(
                evidence_index=[evidence_item, copy.deepcopy(evidence_item)]
            )
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("path repeated" in error for error in errors))

    def test_snapshot_archive_hash_and_regular_file_are_verified(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-snapshot-") as directory:
            root = Path(directory)
            archive = root / "snapshots" / "archive.bin"
            archive.parent.mkdir()
            archive.write_bytes(b"archive payload\n")
            report = _base_report()
            report["preservation"]["snapshot"] = {
                "performed": True,
                "destination": "snapshots/archive.bin",
                "archive_sha256": validator.sha256_file(archive),
                "verified": True,
                "files": 1,
            }
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            self.assertEqual([], validator.audit_session(session, root))

            report["preservation"]["snapshot"]["archive_sha256"] = HASH_B
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("archive_sha256 mismatch" in error for error in errors))

            report["preservation"]["snapshot"]["destination"] = "snapshots"
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(
                any("regular non-symlink file" in error for error in errors)
            )

    def test_external_snapshot_requires_exact_structured_authorization(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="forensic-snapshot-", dir="/tmp"
        ) as directory:
            root = Path(directory) / "evidence"
            root.mkdir()
            external = Path(directory) / "external-archive.bin"
            external.write_bytes(b"external archive\n")
            report = _base_report()
            report["preservation"]["snapshot"] = {
                "performed": True,
                "destination": str(external),
                "archive_sha256": validator.sha256_file(external),
                "verified": True,
                "files": 1,
            }
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(
                any("external snapshot destination" in error for error in errors)
            )

            report["authorization"] = {
                "snapshot_destination": str(external),
                "ledger_write_authorized": False,
            }
            _write_report(session / "FINAL-REPORT.md", _document(report))
            self.assertEqual([], validator.audit_session(session, root))

    @unittest.skipUnless(shutil.which("git"), "Git is required for scope recomputation")
    def test_computed_git_scope_recomputes_sorted_paths_and_digest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-scope-") as directory:
            root = Path(directory)
            repo, base, head, paths, scope_hash = _make_git_repo(root)
            report = _base_report(repository_path=str(repo))
            report["expected_scope"] = {
                "computed": True,
                "base": base,
                "head": head,
                "file_count": len(paths),
                "sha256": scope_hash,
            }
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            self.assertEqual([], validator.audit_session(session, root))

            report["expected_scope"]["file_count"] += 1
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("file_count mismatch" in error for error in errors))

    def test_unavailable_computed_scope_is_unverified_and_cannot_pass_audit(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-scope-") as directory:
            root = Path(directory)
            report = _base_report(repository_path=str(root / "not-a-repository"))
            report["expected_scope"]["computed"] = True
            report["expected_scope"]["base"] = _git_sha("missing-base")
            report["expected_scope"]["head"] = _git_sha("missing-head")
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            errors = validator.audit_session(session, root)
            self.assertTrue(any("UNVERIFIED" in error for error in errors))

    def test_chain_orders_genesis_before_checkpoint_and_writes_deterministic_manifest(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, genesis_report = _make_genesis(root, "GENESIS-2026-12-31")
            checkpoint, _, _ = _make_checkpoint(
                root,
                "CHK-2026-01-01-0001",
                previous=genesis,
            )
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("RESULTADO: CHAIN_PASS", result.stdout)
            manifest_path = root / "chain-manifest.json"
            self.assertTrue(manifest_path.is_file())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                [genesis.name, checkpoint.name],
                [entry["session"] for entry in manifest["sessions"]],
            )
            self.assertEqual("UNVERIFIED", manifest["genesis_anchor"]["status"])
            self.assertEqual(
                validator.sha256_file(genesis_report),
                manifest["genesis_anchor"]["sha256"],
            )
            self.assertEqual(
                validator.sha256_file(SCHEMA_PATH), manifest["schema_sha256"]
            )
            self.assertNotIn("checked_at", manifest)

            first_manifest = manifest_path.read_bytes()
            second = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, second.returncode, second.stderr)
            self.assertEqual(first_manifest, manifest_path.read_bytes())

    def test_chain_records_admission_schema_sha256_per_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root, "GENESIS-2026-12-31")
            _make_checkpoint(root, "CHK-2026-08-29-1200", previous=genesis)
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, result.returncode, result.stderr)
            manifest = json.loads(
                (root / "chain-manifest.json").read_text(encoding="utf-8")
            )
            expected = validator.sha256_file(SCHEMA_PATH)
            for entry in manifest["sessions"]:
                self.assertEqual(expected, entry["schema_sha256"])

    def test_chain_accepts_explicit_genesis_anchor_and_rejects_wrong_anchor(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, genesis_report = _make_genesis(root)
            _make_checkpoint(root, "CHK-2026-08-29-1200", previous=genesis)
            digest = validator.sha256_file(genesis_report)
            good = _run_cli("chain", root, SCHEMA_PATH, "--genesis-sha256", digest)
            self.assertEqual(0, good.returncode, good.stderr)
            manifest_path = root / "chain-manifest.json"
            accepted_manifest = manifest_path.read_bytes()

            wrong = _run_cli(
                "chain",
                root,
                SCHEMA_PATH,
                "--genesis-sha256",
                HASH_C,
            )
            self.assertEqual(1, wrong.returncode)
            self.assertIn("GENESIS anchor mismatch", wrong.stdout)
            self.assertEqual(accepted_manifest, manifest_path.read_bytes())

    def test_chain_accepts_legacy_genesis_without_v2_yaml(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis = root / "GENESIS-2026-08-28"
            genesis.mkdir()
            (genesis / "FINAL-REPORT.md").write_text(
                "legacy seed; schema v2 is intentionally not required\n",
                encoding="utf-8",
            )
            _make_checkpoint(root, "CHK-2026-08-29-1200", previous=genesis)
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, result.returncode, result.stderr)
            manifest = json.loads(
                (root / "chain-manifest.json").read_text(encoding="utf-8")
            )
            self.assertIsNone(manifest["sessions"][0]["session_state"])
            self.assertEqual(
                validator.sha256_file(genesis / "FINAL-REPORT.md"),
                manifest["genesis_anchor"]["sha256"],
            )

    def test_chain_rejects_checkpoint_without_genesis_link(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            _, report_path, report = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
            )
            report["previous_session"] = None
            _write_report(report_path, _document(report))
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, result.returncode)
            self.assertIn("previous_session", result.stdout)
            self.assertFalse((root / "chain-manifest.json").exists())

    def test_chain_rejects_report_symlink_outside_evidence_root(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="forensic-chain-", dir="/tmp"
        ) as directory:
            root = Path(directory) / "evidence"
            root.mkdir()
            genesis, _ = _make_genesis(root)
            checkpoint, report_path, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
            )
            external_report = Path(directory) / "external-report.md"
            external_report.write_bytes(report_path.read_bytes())
            report_path.unlink()
            try:
                report_path.symlink_to(external_report)
            except OSError as exc:
                self.skipTest(f"symlinks unavailable: {exc}")

            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, result.returncode)
            self.assertIn("symlink", result.stderr)
            self.assertFalse((root / "chain-manifest.json").exists())
            self.assertTrue(checkpoint.is_dir())

    def test_chain_pass_requires_the_audit_barrier_for_completed_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            repo, base, head, paths, scope_hash = _make_git_repo(root)
            genesis, _ = _make_genesis(root)
            evidence = root / "proof-a" / "evidence.txt"
            evidence.parent.mkdir()
            evidence.write_bytes(b"real proof bytes\n")
            checkpoint, report_path, report = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
                repository_path=str(repo),
            )
            report = _passing_report(report)
            report["expected_scope"] = {
                "computed": True,
                "base": base,
                "head": head,
                "file_count": len(paths),
                "sha256": scope_hash,
            }
            report["proof_a"]["evidence_index"][0] = {
                "item": "real proof",
                "path": "proof-a/evidence.txt",
                "sha256": validator.sha256_file(evidence),
            }
            _write_report(
                report_path,
                _document(report, proof_validation=_proof_validation_for(report)),
            )
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("CHAIN_PASS", result.stdout)
            self.assertTrue(checkpoint.is_dir())

    def test_chain_candidate_is_validated_without_manifest_write_or_archive(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            checkpoint, _, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
            )
            candidate, candidate_report, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1300",
                previous=checkpoint,
            )
            staging = root / "staging-session"
            candidate.rename(staging)
            result = _run_cli("chain", root, SCHEMA_PATH, "--candidate", staging)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("não escrito", result.stdout)
            self.assertFalse((root / "chain-manifest.json").exists())
            self.assertTrue((staging / "FINAL-REPORT.md").is_file())
            self.assertTrue(staging.is_dir())
            self.assertFalse(candidate.exists())

    def test_chain_rejects_wrong_previous_link_and_directory_session_id(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            checkpoint, checkpoint_report, report = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
            )
            report["previous_session"]["final_report_sha256"] = HASH_A
            _write_report(checkpoint_report, _document(report))
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, result.returncode)
            self.assertIn(
                "CHAIN_BREAK[previous_session.final_report_sha256]", result.stdout
            )

            report["previous_session"]["final_report_sha256"] = validator.sha256_file(
                root / genesis.name / "FINAL-REPORT.md"
            )
            report["session_id"] = "CHK-2026-08-29-1300"
            _write_report(checkpoint_report, _document(report))
            mismatch = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, mismatch.returncode)
            self.assertIn("session_id does not match directory name", mismatch.stdout)

    def test_chain_does_not_skip_invalid_intermediate_checkpoint_and_preserves_manifest(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            first, _, first_report = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
            )
            second, second_report_path, second_report = _make_checkpoint(
                root,
                "CHK-2026-08-29-1300",
                previous=first,
            )
            initial = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, initial.returncode, initial.stderr)
            manifest_path = root / "chain-manifest.json"
            accepted_manifest = manifest_path.read_bytes()

            first_report.pop("proof_b")
            _write_report(first / "FINAL-REPORT.md", _document(first_report))
            second_report["previous_session"]["final_report_sha256"] = (
                validator.sha256_file(first / "FINAL-REPORT.md")
            )
            _write_report(second_report_path, _document(second_report))
            failed = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, failed.returncode)
            self.assertIn(first.name, failed.stdout)
            self.assertEqual(accepted_manifest, manifest_path.read_bytes())
            self.assertTrue(second.is_dir())

    def test_invalid_session_directory_is_a_clean_policy_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            (root / "CHK-not-a-session").mkdir()
            result = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, result.returncode)
            self.assertIn("VALIDATION_FAIL", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_chain_rejects_unauthorized_head_change_but_accepts_authorized_git_head_drift(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            first, _, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
                repository_head=GIT_HEAD_A,
            )
            _make_checkpoint(
                root,
                "CHK-2026-08-29-1300",
                previous=first,
                repository_head=GIT_HEAD_B,
            )
            unauthorized = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, unauthorized.returncode)
            self.assertIn("head_continuity", unauthorized.stdout)

        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            first, _, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
                repository_head=GIT_HEAD_A,
            )
            authorized_drift = {
                "classification": "EXPECTED",
                "items": [
                    {
                        "artifact": "git/HEAD",
                        "previous_sha256": HASH_A,
                        "current_sha256": HASH_B,
                        "classification": "EXPECTED",
                        "authorized": True,
                    }
                ],
            }
            _make_checkpoint(
                root,
                "CHK-2026-08-29-1300",
                previous=first,
                repository_head=GIT_HEAD_B,
                drift=authorized_drift,
            )
            authorized = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, authorized.returncode, authorized.stderr)

    def test_consecutive_waiting_sessions_must_preserve_waiting_since(self) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            first, _, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
                session_state="WAITING_ON_ENVIRONMENT",
            )
            _make_checkpoint(
                root,
                "CHK-2026-08-29-1300",
                previous=first,
                session_state="WAITING_ON_ENVIRONMENT",
            )
            preserved = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(0, preserved.returncode, preserved.stderr)

        with tempfile.TemporaryDirectory(prefix="forensic-chain-") as directory:
            root = Path(directory)
            genesis, _ = _make_genesis(root)
            first, _, _ = _make_checkpoint(
                root,
                "CHK-2026-08-29-1200",
                previous=genesis,
                session_state="WAITING_ON_ENVIRONMENT",
                waiting_since="2026-08-29T10:00:00+00:00",
            )
            _make_checkpoint(
                root,
                "CHK-2026-08-29-1300",
                previous=first,
                session_state="WAITING_ON_ENVIRONMENT",
                waiting_since="2026-08-29T11:00:00+00:00",
            )
            reset = _run_cli("chain", root, SCHEMA_PATH)
            self.assertEqual(1, reset.returncode)
            self.assertIn("sla_timer_reset", reset.stdout)

    def test_verify_wrapper_uses_local_validator_and_exposes_same_exit_boundary(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="forensic-wrapper-") as directory:
            root = Path(directory)
            evidence = root / "evidence.txt"
            evidence.write_bytes(b"wrapper evidence\n")
            item = {
                "item": "wrapper evidence",
                "path": "evidence.txt",
                "sha256": validator.sha256_file(evidence),
            }
            report = _base_report(evidence_index=[item])
            session = root / report["session_id"]
            _write_report(session / "FINAL-REPORT.md", _document(report))
            result = subprocess.run(
                ["bash", str(WRAPPER_PATH), str(session), "--evidence-root", str(root)],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("RESULTADO: AUDIT_PASS", result.stdout)

            usage = subprocess.run(
                ["bash", str(WRAPPER_PATH)],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(2, usage.returncode)
            self.assertIn("usage:", usage.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
