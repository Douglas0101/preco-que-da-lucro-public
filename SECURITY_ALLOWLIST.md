# Snapshot Security Allowlist

## Policy

Deny by default. No broad path, regex, or secret-value suppression is active.

## Classified findings

| Classification   | Count | Treatment                                        |
| ---------------- | ----: | ------------------------------------------------ |
| `TEST_DATA`      |    43 | Evidence removed or exact test literal sanitized |
| `PLACEHOLDER`    |    12 | Exact placeholder literal sanitized              |
| `FALSE_POSITIVE` |     0 | None                                             |
| `REAL_ACTIVE`    |     0 | None confirmed in the classified metadata        |

## Allowlist entries

```text
active_entries=0
```

Findings are not suppressed by this file. They are handled by structural removal or exact sanitization so a future scanner cannot silently inherit a broad exception.

## Scope

- Applies only to `/tmp/preco-public-snapshot-20260925`.
- Does not modify the private source repository.
- Does not establish publication readiness.
- Must be re-evaluated after every rescan.
