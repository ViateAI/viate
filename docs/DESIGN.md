# DESIGN.md

## Selected Style

Style: `vercel` - Vercel-like Developer Console

Fit: Developer tools, deployment products, technical control panels, docs-adjacent apps

Summary: Crisp, monochrome, technical, and grid-disciplined.

This design direction is durable project context. Do not change it unless the product form changes materially.

## Core Rules

- Use crisp black/white hierarchy with sparse accent color.
- Favor technical surfaces: status rows, deployment cards, logs, metrics, code blocks, and environment panels.
- Use strong alignment, precise spacing, and simple geometric composition.
- Use clear empty states and concise technical copy.
- Keep shadows minimal; rely on borders, contrast, and whitespace.

## Avoid

- Warm editorial styling
- Cute illustrations and consumer-app decoration
- Multiple saturated accent colors competing for attention

## Implementation Rules

- Prefer shadcn/ui, Radix primitives, Tailwind semantic tokens, and lucide icons when available.
- Use semantic colors such as `background`, `foreground`, `primary`, `muted`, `border`, `accent`, and `destructive`.
- Use stable dimensions for boards, grids, toolbars, icon buttons, counters, and tiles to prevent layout shift.
- Keep page structure appropriate to the product: app screens should start with the usable workflow, not a marketing hero.
- Do not copy logos, trademarks, proprietary fonts, or brand-specific copy from the inspiration source.
- Verify important UI at mobile and desktop widths before considering the work complete.
