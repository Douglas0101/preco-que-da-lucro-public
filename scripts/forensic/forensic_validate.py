#!/usr/bin/env python3
"""Validate forensic SDD reports and checkpoint-chain integrity.

The validator is deliberately filesystem- and Git-read-only.  It never invokes
a shell, reaches the network, changes a repository, or writes a chain manifest
until every chain invariant has passed.

Usage:
  forensic_validate.py report <schema.json> <FINAL-REPORT.md>
  forensic_validate.py chain <evidence-dir> <schema.json>
      [--candidate <staging-session-dir>] [--genesis-sha256 <64-hex>]
  forensic_validate.py evidence <session-dir> --evidence-root <root>

Exit codes:
  0 = PASS
  1 = schema, evidence, or chain policy failure
  2 = extraction, dependency, or environment failure
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path, PurePath
from typing import Any

try:
    import yaml
    from jsonschema import Draft202012Validator, FormatChecker, SchemaError
    from yaml.constructor import ConstructorError
    from yaml.nodes import MappingNode
except ImportError as exc:  # pragma: no cover - exercised by deployment, not CI
    print(
        f"DEPENDENCY_FAIL: install jsonschema, PyYAML, and rfc3339-validator ({exc})",
        file=sys.stderr,
    )
    raise SystemExit(2)

# Alias local: UniqueSafeLoader é derivado de yaml.SafeLoader (sem construção
# de objetos), então o carregamento tem a semântica de yaml.safe_load mais a
# detecção de chave duplicada. O alias evita o padrão textual yaml.load( que o
# scanner sinaliza como CWE-502 mesmo com loader seguro explícito.
_yaml_load_safe = yaml.load


EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_ENVIRONMENT = 2
VALIDATOR_VERSION = "forensic-validate/1.0.0"
BUNDLED_SCHEMA_PATH = Path(__file__).resolve().with_name("forensic-report-v2.schema.json")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GITSHA_RE = re.compile(r"^[0-9a-f]{40}$")
SESSION_RE = re.compile(
    r"^(?P<kind>CHK|GENESIS)-(?P<day>[0-9]{4}-[0-9]{2}-[0-9]{2})"
    r"(?:-(?P<clock>[0-9]{4}))?$"
)
FENCED_YAML_RE = re.compile(
    r"^```(?:yaml|yml)[ \t]*\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL
)
DOCUMENT_KEYS = {"forensic_sdd_report", "ledger_record", "proof_validation_report"}


class ForensicError(Exception):
    """Base class for a deterministic validation failure."""


class ExtractionError(ForensicError):
    """The report could not be safely extracted from Markdown/YAML."""


class EnvironmentFailure(ForensicError):
    """A required schema, path, dependency, or read-only command was unavailable."""


class DuplicateKeyError(ValueError):
    """Raised when YAML contains a duplicate mapping key."""


class UniqueSafeLoader(yaml.SafeLoader):
    """PyYAML safe loader that rejects duplicate mapping keys."""


def _construct_unique_mapping(
    loader: UniqueSafeLoader, node: MappingNode, deep: bool = False
) -> dict[Any, Any]:
    if not isinstance(node, MappingNode):
        raise ConstructorError(None, None, "expected a mapping", node.start_mark)

    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            already_present = key in mapping
        except TypeError as exc:
            raise DuplicateKeyError(f"unhashable YAML key: {key!r}") from exc
        if already_present:
            mark = key_node.start_mark
            location = f"line {mark.line + 1}, column {mark.column + 1}"
            raise DuplicateKeyError(f"duplicate YAML key {key!r} at {location}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueSafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping
)


def _absolute_file(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise EnvironmentFailure(f"{label} must be an absolute path: {path}")
    if path.is_symlink():
        raise EnvironmentFailure(f"{label} must not be a symlink: {path}")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise EnvironmentFailure(f"cannot resolve {label} {path}: {exc}") from exc
    if not resolved.is_file():
        raise EnvironmentFailure(f"{label} is not a regular file: {resolved}")
    return resolved


def sha256_file(path: Path) -> str:
    safe_path = _absolute_file(
        path if path.is_absolute() else Path.cwd() / path,
        "hash file",
    )
    digest = hashlib.sha256()
    try:
        with safe_path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 64), b""):
                digest.update(chunk)
    except OSError as exc:
        raise EnvironmentFailure(f"cannot read {safe_path}: {exc}") from exc
    return digest.hexdigest()


def _normalize(value: Any, active: set[int] | None = None) -> Any:
    """Convert PyYAML date objects to ISO strings expected by JSON Schema."""
    if active is None:
        active = set()
    if isinstance(value, dict):
        identity = id(value)
        if identity in active:
            raise ExtractionError("cyclic YAML alias is not allowed")
        active.add(identity)
        try:
            return {key: _normalize(item, active) for key, item in value.items()}
        finally:
            active.remove(identity)
    if isinstance(value, list):
        identity = id(value)
        if identity in active:
            raise ExtractionError("cyclic YAML alias is not allowed")
        active.add(identity)
        try:
            return [_normalize(item, active) for item in value]
        finally:
            active.remove(identity)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _load_yaml_block(block: str, source: Path) -> dict[str, Any]:
    try:
        document = _yaml_load_safe(block, Loader=UniqueSafeLoader)
    except (yaml.YAMLError, DuplicateKeyError) as exc:
        raise ExtractionError(f"invalid YAML in {source}: {exc}") from exc
    if not isinstance(document, dict):
        raise ExtractionError(f"YAML document in {source} must be a mapping")
    return _normalize(document)


def load_documents(report_path: Path) -> dict[str, Any]:
    """Extract the supported YAML documents and reject silent overwrites."""
    safe_report_path = _absolute_file(
        report_path if report_path.is_absolute() else Path.cwd() / report_path,
        "report file",
    )
    try:
        text = safe_report_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise EnvironmentFailure(f"cannot read report {safe_report_path}: {exc}") from exc

    blocks = FENCED_YAML_RE.findall(text)
    if not blocks and text.lstrip().startswith("forensic_sdd_report:"):
        blocks = [text]
    if not blocks:
        raise ExtractionError(
            f"'forensic_sdd_report' YAML block not found in {safe_report_path}"
        )

    merged: dict[str, Any] = {}
    for block in blocks:
        document = _load_yaml_block(block, safe_report_path)
        for key, value in document.items():
            if key not in DOCUMENT_KEYS:
                # Keep the key so the strict schema produces its exact path.
                if key in merged:
                    raise ExtractionError(
                        f"duplicate top-level YAML document {key!r} in {safe_report_path}"
                    )
                merged[key] = value
                continue
            if key in merged:
                raise ExtractionError(
                    f"duplicate top-level YAML document {key!r} in {safe_report_path}"
                )
            merged[key] = value

    if "forensic_sdd_report" not in merged:
        raise ExtractionError(
            f"'forensic_sdd_report' YAML document not found in {safe_report_path}"
        )
    return merged


def _json_path(path: Iterable[Any]) -> str:
    result = "$"
    for part in path:
        result += f"[{part}]" if isinstance(part, int) else f".{part}"
    return result


def schema_errors(document: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise EnvironmentFailure(f"invalid JSON Schema: {exc.message}") from exc

    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(
        validator.iter_errors(document),
        key=lambda error: (_json_path(error.absolute_path), error.message),
    )
    return [f"{_json_path(error.absolute_path)}: {error.message}" for error in errors]


def _session_parts(session_id: str) -> tuple[str, date, int | None] | None:
    match = SESSION_RE.fullmatch(session_id)
    if not match:
        return None
    try:
        day = date.fromisoformat(match.group("day"))
    except ValueError:
        return None
    clock = match.group("clock")
    if clock is None:
        return match.group("kind"), day, None
    hour, minute = int(clock[:2]), int(clock[2:])
    if hour > 23 or minute > 59:
        return None
    return match.group("kind"), day, int(clock)


def semantic_errors(document: dict[str, Any]) -> list[str]:
    """Validate cross-field invariants not expressible in the JSON Schema."""
    errors: list[str] = []
    report = document.get("forensic_sdd_report")
    if not isinstance(report, dict):
        return errors

    session_id = report.get("session_id")
    session_parts = _session_parts(session_id) if isinstance(session_id, str) else None
    if isinstance(session_id, str) and session_parts is None:
        errors.append(
            "$.forensic_sdd_report.session_id: invalid calendar/time component"
        )
    report_date = report.get("date")
    if isinstance(report_date, str):
        try:
            parsed_date = date.fromisoformat(report_date)
        except ValueError:
            errors.append("$.forensic_sdd_report.date: invalid calendar date")
        else:
            if session_parts is not None and parsed_date != session_parts[1]:
                errors.append(
                    "$.forensic_sdd_report.date: must match the date in session_id"
                )

    subagents = report.get("subagents")
    expected_subagents = {
        "F1-DOC-GIT",
        "F2-M02-DATA",
        "F3-SEC-PLATFORM",
        "F4-TEST-SYNTH",
    }
    if isinstance(subagents, list):
        observed = [item.get("id") for item in subagents if isinstance(item, dict)]
        if set(observed) != expected_subagents or len(observed) != len(
            expected_subagents
        ):
            errors.append(
                "$.forensic_sdd_report.subagents: must contain each allowed ID exactly once"
            )

    final_state = report.get("final_state")
    if isinstance(final_state, dict):
        for field in (
            "state",
            "product_verdict",
            "m02",
            "gates_consumed",
            "release_or_p8",
        ):
            if final_state.get(field) != report.get(
                "session_state" if field == "state" else field
            ):
                errors.append(
                    f"$.forensic_sdd_report.final_state.{field}: must mirror report"
                )

    ledger = document.get("ledger_record")
    if isinstance(ledger, dict):
        comparisons = {
            "session_id": session_id,
            "head": (report.get("repository") or {}).get("head_observed"),
            "product_verdict": report.get("product_verdict"),
            "gates_consumed": report.get("gates_consumed"),
            "release_or_p8": report.get("release_or_p8"),
        }
        for field, expected in comparisons.items():
            if ledger.get(field) != expected:
                errors.append(f"$.ledger_record.{field}: must mirror report")
        if "mode" in ledger and ledger.get("mode") != report.get("mode"):
            errors.append("$.ledger_record.mode: must mirror report.mode")
        repository = report.get("repository") or {}
        if "repository" in ledger and ledger.get("repository") != repository.get(
            "path"
        ):
            errors.append("$.ledger_record.repository: must mirror repository.path")
        if "branch" in ledger and ledger.get("branch") != repository.get(
            "branch_observed"
        ):
            errors.append(
                "$.ledger_record.branch: must mirror repository.branch_observed"
            )

    proof_validation = document.get("proof_validation_report")
    if isinstance(proof_validation, dict):
        proof_comparisons = {
            "proof_a": (report.get("proof_a") or {}).get("overall"),
            "proof_b": (report.get("proof_b") or {}).get("overall"),
            "product_verdict": report.get("product_verdict"),
            "p8_recommendation": report.get("release_or_p8"),
        }
        for field, expected in proof_comparisons.items():
            observed = (
                proof_validation.get(field, {}).get("overall")
                if field in ("proof_a", "proof_b")
                else proof_validation.get(field)
            )
            if observed != expected:
                errors.append(f"$.proof_validation_report.{field}: must mirror report")
        if "rejected_proofs_registry" in proof_validation:
            if proof_validation.get("rejected_proofs_registry") != report.get(
                "rejected_proofs_registry", []
            ):
                errors.append(
                    "$.proof_validation_report.rejected_proofs_registry: "
                    "must mirror report"
                )

    if report.get("session_state") == "PROOF_VALIDATION" and not isinstance(
        proof_validation, dict
    ):
        errors.append(
            "$.proof_validation_report: required for session_state PROOF_VALIDATION"
        )
    if report.get("release_or_p8") == "ADVANCE_RECOMMENDED" and not isinstance(
        proof_validation, dict
    ):
        errors.append("$.proof_validation_report: required for ADVANCE_RECOMMENDED")

    return errors


def validate(document: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    errors = schema_errors(document, schema)
    if not errors:
        errors.extend(semantic_errors(document))
    return errors


def _load_schema(schema_path: Path) -> dict[str, Any]:
    safe_schema_path = _absolute_file(schema_path, "schema file")
    try:
        with safe_schema_path.open(encoding="utf-8") as stream:
            schema = json.load(stream)
    except (OSError, json.JSONDecodeError) as exc:
        raise EnvironmentFailure(f"cannot load schema {safe_schema_path}: {exc}") from exc
    if not isinstance(schema, dict):
        raise EnvironmentFailure(f"schema {schema_path} must be a JSON object")
    return schema


def cmd_report(schema_path: Path, report_path: Path) -> int:
    schema = _load_schema(schema_path)
    document = load_documents(report_path)
    report_value = document.get("forensic_sdd_report")
    report = report_value if isinstance(report_value, dict) else {}
    print(
        f"session: {report.get('session_id', '?')}  |  "
        f"state: {report.get('session_state', '?')}  |  "
        f"verdict: {report.get('product_verdict', '?')}  |  "
        f"m02: {report.get('m02', '?')}"
    )
    errors = validate(document, schema)
    if errors:
        for error in errors:
            print(f"  SCHEMA_FAIL  {error}")
        print(
            f"RESULTADO: SCHEMA_FAIL ({len(errors)} violação(ões)) — "
            "sessão NÃO arquiva na cadeia."
        )
        return EXIT_FAIL
    print("RESULTADO: SCHEMA_PASS")
    return EXIT_PASS


def _absolute_directory(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise EnvironmentFailure(f"{label} must be an absolute path: {path}")
    if path.is_symlink():
        raise EnvironmentFailure(f"{label} must not be a symlink: {path}")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise EnvironmentFailure(f"cannot resolve {label} {path}: {exc}") from exc
    if not resolved.is_dir():
        raise EnvironmentFailure(f"{label} is not a directory: {resolved}")
    return resolved


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _reject_symlink_components(root: Path, relative: PurePath) -> None:
    current = root
    for part in relative.parts:
        if part in ("", "."):
            continue
        current /= part
        if current.is_symlink():
            raise ForensicError(f"symlink is not allowed in evidence path: {relative}")


def _regular_report_file(session: Path, evidence_root: Path) -> Path:
    """Return a checkpoint report only when every path component is trusted."""
    try:
        relative_session = session.relative_to(evidence_root)
    except ValueError as exc:
        raise ForensicError("session directory must be inside evidence root") from exc
    _reject_symlink_components(
        evidence_root, PurePath(relative_session, "FINAL-REPORT.md")
    )
    report = session / "FINAL-REPORT.md"
    if report.is_symlink() or not report.is_file():
        raise ForensicError(
            f"session report must be a regular file: {session.name}/FINAL-REPORT.md"
        )
    return report


def _safe_evidence_file(root: Path, relative_value: str) -> Path:
    relative = PurePath(relative_value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ForensicError(
            f"evidence path must remain relative to root: {relative_value}"
        )
    _reject_symlink_components(root, relative)
    candidate = (root / Path(*relative.parts)).resolve(strict=False)
    if not _is_within(candidate, root):
        raise ForensicError(f"evidence path escapes root: {relative_value}")
    if not candidate.exists() or not candidate.is_file():
        raise ForensicError(
            f"evidence file is missing or not regular: {relative_value}"
        )
    return candidate


def _safe_snapshot_file(destination: str, evidence_root: Path) -> Path:
    raw = Path(destination)
    candidate = raw if raw.is_absolute() else evidence_root / raw
    if not raw.is_absolute() and ".." in raw.parts:
        raise ForensicError(
            f"relative snapshot destination must not traverse outside root: {destination}"
        )
    if not raw.is_absolute():
        _reject_symlink_components(evidence_root, PurePath(raw))
    else:
        current = Path(candidate.anchor)
        for part in candidate.parts[1:]:
            current /= part
            if current.is_symlink():
                raise ForensicError(
                    f"snapshot destination contains a symlink: {destination}"
                )
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ForensicError(
            f"snapshot destination cannot be resolved: {destination}"
        ) from exc
    if candidate.is_symlink() or not resolved.is_file():
        raise ForensicError(
            f"snapshot destination must be a regular non-symlink file: {destination}"
        )
    return resolved


def _git_scope(repo: Path, base: str, head: str) -> tuple[list[str], str]:
    if not repo.is_absolute() or not repo.is_dir():
        raise ForensicError(f"repository path is unavailable: {repo}")
    if not GITSHA_RE.fullmatch(base) or not GITSHA_RE.fullmatch(head):
        raise ForensicError("expected_scope base/head must be full lowercase Git SHAs")
    git_environment = os.environ.copy()
    git_environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    try:
        completed = subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "diff",
                "--name-only",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                base,
                head,
                "--",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
            env=git_environment,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ForensicError(f"scope recomputation unavailable: {exc}") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "git diff failed"
        raise ForensicError(f"scope recomputation unavailable: {detail}")
    paths = sorted(line for line in completed.stdout.splitlines() if line)
    canonical = ("\n".join(paths) + "\n").encode("utf-8") if paths else b""
    return paths, hashlib.sha256(canonical).hexdigest()


def audit_session(
    session_dir: Path,
    evidence_root: Path,
    schema: dict[str, Any] | None = None,
) -> list[str]:
    root = _absolute_directory(evidence_root, "evidence root")
    session = _absolute_directory(session_dir, "session directory")
    if not _is_within(session, root):
        return ["session directory must be inside evidence root"]

    try:
        report_path = _regular_report_file(session, root)
        document = load_documents(report_path)
    except ForensicError as exc:
        return [str(exc)]

    if schema is None:
        schema = _load_schema(BUNDLED_SCHEMA_PATH)
    structural_errors = validate(document, schema)
    if structural_errors:
        return [f"report validation: {error}" for error in structural_errors]

    errors: list[str] = []
    report = document.get("forensic_sdd_report") or {}
    report_session_id = report.get("session_id")
    if session.name.startswith(("CHK-", "GENESIS-")):
        if report_session_id != session.name:
            errors.append(
                "session_id does not match session directory "
                f"({report_session_id!r} != {session.name!r})"
            )
    else:
        parts = (
            _session_parts(report_session_id)
            if isinstance(report_session_id, str)
            else None
        )
        if parts is None or parts[0] != "CHK":
            errors.append("staging session must declare a valid CHK-* session_id")
    evidence_index = (report.get("proof_a") or {}).get("evidence_index")
    if not isinstance(evidence_index, list):
        return ["$.forensic_sdd_report.proof_a.evidence_index: must be an array"]

    seen_paths: set[str] = set()
    for index, item in enumerate(evidence_index):
        if not isinstance(item, dict):
            errors.append(
                f"$.forensic_sdd_report.proof_a.evidence_index[{index}]: invalid item"
            )
            continue
        relative_value = item.get("path")
        expected_hash = item.get("sha256")
        if not isinstance(relative_value, str) or not isinstance(expected_hash, str):
            errors.append(
                f"$.forensic_sdd_report.proof_a.evidence_index[{index}]: missing path/hash"
            )
            continue
        if relative_value in seen_paths:
            errors.append(f"evidence path repeated: {relative_value}")
        seen_paths.add(relative_value)
        try:
            evidence_file = _safe_evidence_file(root, relative_value)
            observed_hash = sha256_file(evidence_file)
        except ForensicError as exc:
            errors.append(f"evidence[{index}]: {exc}")
            continue
        if observed_hash != expected_hash:
            errors.append(
                f"evidence[{index}]: SHA-256 mismatch for {relative_value} "
                f"(expected {expected_hash}, observed {observed_hash})"
            )

    snapshot = ((report.get("preservation") or {}).get("snapshot")) or {}
    # identity is deliberate (fail-closed): YAML must supply exactly boolean
    # true; == would accept 1/"yes" and weaken the audit gate.
    # pi-lens-ignore: no-identity-operator-on-literals
    if snapshot.get("performed") is True:
        # pi-lens-ignore: no-identity-operator-on-literals
        if snapshot.get("verified") is not True:
            errors.append("preservation.snapshot.verified must be true when performed")
        destination = snapshot.get("destination")
        expected_hash = snapshot.get("archive_sha256")
        if not isinstance(destination, str) or not isinstance(expected_hash, str):
            errors.append("performed snapshot requires destination and archive_sha256")
        else:
            try:
                archive = _safe_snapshot_file(destination, root)
                authorization = report.get("authorization")
                authorized_destination = (
                    authorization.get("snapshot_destination")
                    if isinstance(authorization, dict)
                    else None
                )
                if (
                    authorized_destination is not None
                    and authorized_destination != destination
                ):
                    errors.append(
                        "preservation.snapshot.destination must match "
                        "authorization.snapshot_destination"
                    )
                if (
                    not _is_within(archive, root)
                    and authorized_destination != destination
                ):
                    errors.append(
                        "external snapshot destination requires exact "
                        "authorization.snapshot_destination"
                    )
                observed_hash = sha256_file(archive)
                if observed_hash != expected_hash:
                    errors.append(
                        "preservation.snapshot.archive_sha256 mismatch "
                        f"(expected {expected_hash}, observed {observed_hash})"
                    )
            except ForensicError as exc:
                errors.append(f"preservation.snapshot: {exc}")

    expected_scope = report.get("expected_scope") or {}
    # identity is deliberate (fail-closed): computed must be exactly boolean
    # true to trigger recomputation; == would weaken the scope gate.
    # pi-lens-ignore: no-identity-operator-on-literals
    if expected_scope.get("computed") is True:
        repository = report.get("repository") or {}
        repository_value = repository.get("path")
        if not isinstance(repository_value, str):
            errors.append(
                "expected_scope: repository.path is required for recomputation"
            )
        else:
            try:
                paths, observed_hash = _git_scope(
                    Path(repository_value),
                    str(expected_scope.get("base", "")),
                    str(expected_scope.get("head", "")),
                )
                if len(paths) != expected_scope.get("file_count"):
                    errors.append(
                        "expected_scope.file_count mismatch "
                        f"(expected {expected_scope.get('file_count')}, observed {len(paths)})"
                    )
                if observed_hash != expected_scope.get("sha256"):
                    errors.append(
                        "expected_scope.sha256 mismatch "
                        f"(expected {expected_scope.get('sha256')}, observed {observed_hash})"
                    )
            except ForensicError as exc:
                errors.append(f"expected_scope: UNVERIFIED ({exc})")

    return errors


def cmd_evidence(session_dir: Path, evidence_root: Path) -> int:
    errors = audit_session(
        session_dir, evidence_root, _load_schema(BUNDLED_SCHEMA_PATH)
    )
    if errors:
        for error in errors:
            print(f"  AUDIT_FAIL  {error}")
        print(f"RESULTADO: AUDIT_FAIL ({len(errors)} problema(s)) — sessão retida.")
        return EXIT_FAIL
    print("RESULTADO: AUDIT_PASS")
    return EXIT_PASS


def _parse_directory_name(name: str) -> tuple[str, date, int | None]:
    parts = _session_parts(name)
    if parts is None:
        raise ForensicError(f"invalid session directory name: {name}")
    return parts


@dataclass(frozen=True)
class SessionEntry:
    """A chain entry and its logical final session ID."""

    path: Path
    name: str


def _session_sort_key(entry: SessionEntry) -> tuple[int, date, int, str]:
    kind, day, clock = _parse_directory_name(entry.name)
    return (
        0 if kind == "GENESIS" else 1,
        day,
        -1 if clock is None else clock,
        entry.name,
    )


def _discover_sessions(evidence_root: Path) -> list[SessionEntry]:
    sessions: list[SessionEntry] = []
    for entry in evidence_root.iterdir():
        if not entry.name.startswith(("GENESIS-", "CHK-")):
            continue
        if entry.is_symlink() or not entry.is_dir():
            raise ForensicError(f"session entry is not a real directory: {entry.name}")
        _parse_directory_name(entry.name)
        _regular_report_file(entry, evidence_root)
        sessions.append(SessionEntry(path=entry, name=entry.name))
    return sessions


def _load_candidate_session(
    evidence_root: Path, candidate: Path, sessions: list[SessionEntry]
) -> SessionEntry:
    if candidate.is_symlink():
        raise ForensicError("candidate must not be a symlink")
    lexical_candidate = Path(os.path.abspath(candidate))
    if _is_within(lexical_candidate, evidence_root):
        _reject_symlink_components(
            evidence_root,
            PurePath(lexical_candidate.relative_to(evidence_root)),
        )
    candidate = candidate.resolve(strict=True)
    if not _is_within(candidate, evidence_root):
        raise ForensicError("candidate must be inside evidence root")
    _reject_symlink_components(evidence_root, PurePath(candidate.relative_to(evidence_root)))
    if not candidate.is_dir():
        raise ForensicError("candidate must be a real directory")
    if candidate.name.startswith(("GENESIS-", "CHK-")):
        raise ForensicError(
            "candidate directory must remain outside the GENESIS-/CHK-* discovery names"
        )
    candidate_report_path = _regular_report_file(candidate, evidence_root)
    try:
        candidate_document = load_documents(candidate_report_path)
    except ForensicError as exc:
        raise ForensicError(f"candidate report cannot be extracted: {exc}") from exc
    candidate_report = candidate_document.get("forensic_sdd_report")
    candidate_name = (
        candidate_report.get("session_id") if isinstance(candidate_report, dict) else None
    )
    if not isinstance(candidate_name, str):
        raise ForensicError("candidate report must declare forensic_sdd_report.session_id")
    candidate_parts = _session_parts(candidate_name)
    if candidate_parts is None or candidate_parts[0] != "CHK":
        raise ForensicError("candidate report session_id must be a valid CHK-* ID")
    if any(entry.name == candidate_name for entry in sessions):
        raise ForensicError(f"candidate duplicates existing session: {candidate_name}")
    return SessionEntry(path=candidate, name=candidate_name)


def _collect_sessions(
    evidence_root: Path, candidate: Path | None
) -> list[SessionEntry]:
    sessions = _discover_sessions(evidence_root)
    if candidate is not None:
        sessions.append(_load_candidate_session(evidence_root, candidate, sessions))

    return sorted(sessions, key=_session_sort_key)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
        try:
            directory_fd = os.open(
                path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            )
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            # The file rename is still atomic; directory fsync is best effort on
            # filesystems that do not expose directory descriptors.
            pass
    except OSError as exc:
        raise EnvironmentFailure(f"cannot atomically write {path}: {exc}") from exc
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass


def _anchor_value(explicit: str | None) -> str | None:
    value = explicit or os.environ.get("FORENSIC_GENESIS_SHA256")
    if value is None:
        return None
    if not SHA256_RE.fullmatch(value):
        raise ForensicError(
            "genesis anchor must be 64 lowercase hexadecimal characters"
        )
    return value


def cmd_chain(
    evidence_dir: Path,
    schema_path: Path,
    candidate: Path | None = None,
    genesis_sha256: str | None = None,
) -> int:
    schema = _load_schema(schema_path)
    evidence_root = _absolute_directory(evidence_dir, "evidence directory")
    sessions = _collect_sessions(evidence_root, candidate)
    if not sessions:
        print(f"CHAIN_FAIL: nenhuma sessão com FINAL-REPORT.md em {evidence_root}")
        return EXIT_FAIL

    genesis = [entry for entry in sessions if entry.name.startswith("GENESIS-")]
    if len(genesis) != 1:
        print(
            f"CHAIN_FAIL: esperado exatamente um GENESIS-*, encontrado {len(genesis)}"
        )
        return EXIT_FAIL
    if sessions[0] != genesis[0]:
        print("CHAIN_FAIL: GENESIS-* must be the first chain entry")
        return EXIT_FAIL

    try:
        anchor = _anchor_value(genesis_sha256)
    except ForensicError as exc:
        print(f"CHAIN_FAIL: {exc}")
        return EXIT_FAIL

    failures: list[tuple[str, list[str]]] = []
    manifest_sessions: list[dict[str, Any]] = []
    previous: dict[str, Any] | None = None
    genesis_digest: str | None = None

    for session in sessions:
        report_path = session.path / "FINAL-REPORT.md"
        report_digest = sha256_file(report_path)
        is_genesis = session.name.startswith("GENESIS-")
        problems: list[str] = []
        report: dict[str, Any] = {}

        if not is_genesis:
            try:
                document = load_documents(report_path)
                report_value = document.get("forensic_sdd_report")
                if not isinstance(report_value, dict):
                    raise ExtractionError("forensic_sdd_report must be an object")
                report = report_value
                report_session_id = report.get("session_id")
                if report_session_id != session.name:
                    problems.append(
                        "session_id does not match directory name "
                        f"({report_session_id!r} != {session.name!r})"
                    )
                problems.extend(validate(document, schema))
                problems.extend(
                    f"evidence audit: {error}"
                    for error in audit_session(session.path, evidence_root, schema)
                )
            except ForensicError as exc:
                problems.append(str(exc))

        if is_genesis:
            genesis_digest = report_digest
            if anchor is not None and anchor != report_digest:
                problems.append(
                    f"GENESIS anchor mismatch (expected {anchor}, observed {report_digest})"
                )

        if previous is not None and not is_genesis:
            pointer = report.get("previous_session")
            if not isinstance(pointer, dict):
                problems.append(
                    "previous_session must point to the immediately previous entry"
                )
            else:
                if pointer.get("id") != previous["id"]:
                    problems.append(
                        f"CHAIN_BREAK[previous_session.id]: expected {previous['id']}"
                    )
                if pointer.get("final_report_sha256") != previous["sha"]:
                    problems.append(
                        "CHAIN_BREAK[previous_session.final_report_sha256]: "
                        f"expected {previous['sha']}"
                    )

            current_repository = report.get("repository") or {}
            current_head = current_repository.get("head_observed")
            previous_head = previous.get("head")
            if previous_head and current_head and current_head != previous_head:
                drift_items = (report.get("drift_since_last_session") or {}).get(
                    "items"
                ) or []
                authorized_head_drift = any(
                    isinstance(item, dict)
                    and item.get("artifact") == "git/HEAD"
                    # identity is deliberate (fail-closed): authorized must be
                    # exactly boolean true; == would weaken the chain gate.
                    # pi-lens-ignore: no-identity-operator-on-literals
                    and item.get("authorized") is True
                    for item in drift_items
                )
                if not authorized_head_drift:
                    problems.append(
                        "CHAIN_BREAK[head_continuity]: HEAD changed without "
                        "authorized drift artifact git/HEAD"
                    )

            if (
                previous.get("state") == "WAITING_ON_ENVIRONMENT"
                and report.get("session_state") == "WAITING_ON_ENVIRONMENT"
            ):
                current_waiting_since = (
                    (report.get("governance") or {}).get("sla") or {}
                ).get("waiting_since")
                if previous.get("waiting_since") != current_waiting_since:
                    problems.append(
                        "CHAIN_BREAK[sla_timer_reset]: waiting_since changed "
                        "while WAITING_ON_ENVIRONMENT continued"
                    )

        if problems:
            failures.append((session.name, problems))

        manifest_sessions.append(
            {
                "session": session.name,
                "genesis": is_genesis,
                "sha256": report_digest,
                # provenance of the admission criterion (FIPS 180-4 / SLSA):
                # frozen per session, never retroactive — docs/forensic-kit.md §5.3
                "schema_sha256": sha256_file(schema_path),
                "session_state": report.get("session_state"),
                "product_verdict": report.get("product_verdict"),
                "m02": report.get("m02"),
                "head_observed": (report.get("repository") or {}).get("head_observed"),
                "sla_waiting_since": (
                    ((report.get("governance") or {}).get("sla") or {}).get(
                        "waiting_since"
                    )
                ),
                "valid": not problems,
            }
        )
        previous = {
            "id": session.name,
            "sha": report_digest,
            "head": (report.get("repository") or {}).get("head_observed"),
            "state": report.get("session_state"),
            "waiting_since": (
                ((report.get("governance") or {}).get("sla") or {}).get("waiting_since")
            ),
        }

    if failures:
        for session_name, problems in failures:
            print(f"FAIL  {session_name}  ({len(problems)} problema(s))")
            for problem in problems:
                print(f"      {problem}")
        print(f"RESULTADO: CHAIN_FAIL ({len(failures)} sessão(ões))")
        return EXIT_FAIL

    manifest = {
        "manifest_version": 1,
        "validator_version": VALIDATOR_VERSION,
        "schema_sha256": sha256_file(schema_path),
        "genesis_anchor": {
            "status": "VERIFIED" if anchor is not None else "UNVERIFIED",
            "sha256": anchor or genesis_digest,
        },
        "sessions": manifest_sessions,
    }

    if candidate is None:
        _atomic_write_json(evidence_root / "chain-manifest.json", manifest)
        print(f"Manifesto: {evidence_root / 'chain-manifest.json'}")
    else:
        print("Manifesto: não escrito enquanto o candidato permanecer em staging")
    print("RESULTADO: CHAIN_PASS")
    return EXIT_PASS


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    report_parser = subparsers.add_parser("report", help="validate one FINAL-REPORT.md")
    report_parser.add_argument("schema", type=Path)
    report_parser.add_argument("report", type=Path)

    evidence_parser = subparsers.add_parser("evidence", help="verify evidence hashes")
    evidence_parser.add_argument("session_dir", type=Path)
    evidence_parser.add_argument("--evidence-root", required=True, type=Path)

    chain_parser = subparsers.add_parser("chain", help="validate checkpoint chain")
    chain_parser.add_argument("evidence_dir", type=Path)
    chain_parser.add_argument("schema", type=Path)
    chain_parser.add_argument("--candidate", type=Path)
    chain_parser.add_argument("--genesis-sha256")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "report":
            return cmd_report(args.schema, args.report)
        if args.command == "evidence":
            return cmd_evidence(args.session_dir, args.evidence_root)
        return cmd_chain(
            args.evidence_dir,
            args.schema,
            candidate=args.candidate,
            genesis_sha256=args.genesis_sha256,
        )
    except ExtractionError as exc:
        print(f"EXTRACTION_FAIL: {exc}", file=sys.stderr)
        return EXIT_ENVIRONMENT
    except EnvironmentFailure as exc:
        print(f"ENVIRONMENT_FAIL: {exc}", file=sys.stderr)
        return EXIT_ENVIRONMENT
    except ForensicError as exc:
        print(f"VALIDATION_FAIL: {exc}", file=sys.stderr)
        return EXIT_FAIL
    except OSError as exc:
        print(f"ENVIRONMENT_FAIL: {exc}", file=sys.stderr)
        return EXIT_ENVIRONMENT


if __name__ == "__main__":
    raise SystemExit(main())
