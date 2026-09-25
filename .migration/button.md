# button

2026-08-01, transformation engine against the official Base UI wrapper shape, migrated.

## Changed

- `src/components/ui/button.tsx`: replaced Radix Slot with the real `@base-ui/react/button` primitive while preserving every CVA variant and product class.
- `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/routes/_authenticated/inicio.tsx`, and `src/routes/_authenticated/produtos.tsx`: replaced nested Link/Button markup with Base UI `render` composition.
- `src/routes/auth.tsx`: replaced the raw mode-switch button with the local Button wrapper.
- The source sweep for `radix-ui`, `@radix-ui`, and `asChild` is clean.

## Left alone

- `src/styles.css`: product colors, spacing, shadows, radii, and typography remain unchanged.
- Semantic TanStack Links that are not styled as buttons remain links.

## Behavior changes

- Polymorphic composition now uses Base UI `render` instead of Radix `asChild`.
- Invalid nested interactive elements were removed.

## Verify by hand

- Activate action buttons with Space and Enter.
- Follow every button-like navigation link and confirm its destination.
- Confirm disabled buttons do not invoke their handlers.
- Inspect the DOM and confirm there is no `a button` or `button a` nesting.
