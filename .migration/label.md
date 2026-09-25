# label

2026-08-01, official native-label Base UI migration rule, migrated.

## Changed

- `src/components/ui/label.tsx`: replaced Radix Label with the native shadcn Base implementation and preserved its classes.
- Form routes now use stable `id` and `htmlFor` pairs, including Select triggers and the conversational textarea.
- The remaining purchase-price label now uses the local Label wrapper.
- The source sweep for `radix-ui` and `@radix-ui` is clean.

## Left alone

- Native label rendering inside the shadcn wrapper is intentional because Base UI has no Label primitive.
- Existing field layout and visual tokens remain unchanged.

## Behavior changes

- Label behavior now relies directly on native HTML semantics instead of Radix Label.

## Verify by hand

- Click every visible label and confirm focus moves to its field or Select trigger.
- Confirm screen readers announce labels for all form fields.
- Confirm the hidden chat label provides the textarea accessible name.
