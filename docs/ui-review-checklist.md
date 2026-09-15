# UI Review Checklist

Use this checklist after AI-generated frontend changes.

- The implementation follows `docs/DESIGN.md`.
- The screen matches the selected product form; it does not drift into an unrelated landing-page or dashboard style.
- Text does not overflow buttons, cards, tables, sidebars, or navigation.
- No incoherent overlaps at 375px, 768px, and desktop widths.
- Primary, secondary, destructive, disabled, loading, empty, and error states are visually distinct when relevant.
- Cards are not nested inside cards unless there is a real repeated item or modal/tool frame.
- Colors use semantic tokens or the project design system rather than one-off hard-coded values.
- Interactions are obvious: hover, focus, active, selected, and keyboard states are present where needed.
- The interface is usable before it is decorative.
