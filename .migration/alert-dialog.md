# alert-dialog

2026-08-01, official Base UI Alert Dialog shape with local Button composition, migrated and adopted.

## Changed

- `src/components/ui/alert-dialog.tsx`: migrated Root, Trigger, Portal, Backdrop, Popup, Close, Title, and Description to `@base-ui/react/alert-dialog`.
- Action and Cancel render the local Base UI Button and close through the Base UI Close primitive.
- `despesas.tsx`, `produtos.tsx`, and `novo-produto.tsx`: replaced browser `confirm()` with explicit Portuguese Alert Dialog flows.
- The source sweep for `confirm()`, `radix-ui`, and `@radix-ui` is clean.

## Left alone

- Delete/reset server calls and success/error toasts retain their prior business behavior.
- Destructive actions still begin only after explicit user confirmation.

## Behavior changes

- Confirmations now provide accessible title, description, focus management, and styled destructive/cancel actions.
- Browser-native confirmation UI is no longer used.

## Verify by hand

- Open each destructive confirmation and verify no mutation occurs before the action button is pressed.
- Cancel and confirm with keyboard only.
- Confirm focus starts inside the alert, does not escape, and returns to the trigger after close.
- Simulate a failed deletion and confirm the existing error toast remains visible.
