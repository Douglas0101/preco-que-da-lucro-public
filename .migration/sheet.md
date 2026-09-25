# sheet

2026-08-01, official Base UI Dialog-backed Sheet shape with preserved product classes, migrated and adopted.

## Changed

- `src/components/ui/sheet.tsx`: migrated Root, Trigger, Portal, Backdrop, Popup, Close, Title, and Description to `@base-ui/react/dialog`.
- Replaced Radix state animations with Base UI starting/ending style attributes and reduced-motion handling.
- `src/components/app-shell.tsx`: replaced the hand-rolled mobile drawer and backdrop with the local Sheet.
- The source sweep for `radix-ui` and `@radix-ui` outside wrappers is clean.

## Left alone

- The desktop sidebar layout and navigation styling remain unchanged.
- The sidebar brand palette and route list remain unchanged.

## Behavior changes

- Mobile navigation now has focus trapping, Escape handling, scroll locking, outside dismissal, and trigger focus restoration from Base UI.
- Route activation closes the controlled Sheet.

## Verify by hand

- At mobile width, open the menu and tab through all controls without focus escaping.
- Close with Escape, the close button, outside press, and a navigation link.
- Confirm focus returns to the menu trigger and background scrolling is locked while open.
- Confirm the desktop sidebar is unchanged at the large breakpoint.
