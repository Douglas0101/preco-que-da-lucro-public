# select

2026-08-01, transformation engine using the installed Base UI type definitions and official wrapper anatomy, migrated.

## Changed

- `src/components/ui/select.tsx`: migrated Root, Trigger, Value, Portal, Positioner, Popup, List, Item, indicators, and scroll arrows to `@base-ui/react/select`.
- Replaced Radix CSS variables and state selectors with Base UI positioning variables and starting/ending style attributes.
- Preserved the application-facing string `value` and non-null `onValueChange` contract.
- Added stable trigger IDs for all current Select labels.
- The source sweep for `radix-ui`, `@radix-ui`, and `--radix-` is clean.

## Left alone

- Existing route state and business values remain strings.
- Existing product colors, sizing, border, and focus-ring classes remain unchanged.

## Behavior changes

- Popup positioning now uses Base UI Positioner and Popup rather than Radix Content and Viewport.
- Highlighted items use Base UI `data-highlighted`; disabled items use `data-disabled`.

## Verify by hand

- Open each Select with mouse, Enter, Space, and ArrowDown.
- Navigate options with arrows and typeahead, select with Enter, and close with Escape.
- Confirm focus returns to the trigger and the selected value is announced.
- Check popup width and placement at desktop and mobile widths.
