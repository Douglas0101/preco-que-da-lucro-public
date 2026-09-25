# Project migration

2026-08-01, whole-project Radix to Base UI migration completed without Git metadata or commits by explicit user authorization.

## Scope

- Retained exactly ten wrappers: alert-dialog, badge, button, card, input, label, select, sheet, sonner, and textarea.
- Migrated all retained interactive primitives to Base UI and kept Sonner behind its local wrapper.
- Removed 36 dormant wrappers and their unused specialist packages.
- Removed all direct and transitive Radix packages, `cmdk`, and `vaul`.
- Set `components.json` to `base-nova` for future additions without replacing product tokens or restyling retained wrappers.
- Standardized installation on npm and `package-lock.json`; removed Bun lock/config files.

## Baseline

- `npm ci`, typecheck, and production build passed before migration.
- Prettier check failed on 27 existing files.
- Full lint failed with 625 existing findings, mostly formatting.
- npm audit reported one high development-only `brace-expansion` advisory.
- The baseline client CSS was 79.91 kB and the Radix Select chunk was 84.55 kB.

## Final evidence

- `npm run check:ui-stack` verifies the exact catalog, import boundary, package manager, manifest, lockfile, and zero Radix residue.
- Vitest covers Button composition, Select keyboard behavior, Sheet focus/close behavior, Alert Dialog confirmation, and axe checks.
- Playwright smoke and axe checks pass in Chromium desktop and Chromium mobile emulation.
- The production dependency audit is clean, and `npm audit fix` removed the development advisory.
- The final client CSS is 39.75 kB and the Base UI Select chunk is 69.54 kB.

## Known baseline debt

- Full repository formatting and lint cleanup remain outside this migration; `lint:ui` isolates the migrated surface and reports no errors.
- Manual NVDA and VoiceOver verification still requires the target desktop operating systems.
- The workspace still has no Git metadata, so no commit-based rollback evidence exists.
