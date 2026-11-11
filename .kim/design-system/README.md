# Factory design system

The design language is **shadcn/ui** (zinc theme, Geist font). The real app uses shadcn/ui components on TanStack Start, the same stack as Relationship OS. These files are the reference for mockups and for theming the app.

- `tokens.css`: every colour, type, spacing, radius and shadow value, as CSS custom properties on `:root` (with dark mode). Colours are HSL triplets, so use them as `hsl(var(--primary))`.
- `components.css`: plain-CSS versions of the shadcn components the mockups use (sidebar shell, Card, Badge, Button, Table, Tabs, Input, Kbd, Progress) plus factory-specific pieces (status dots, stage steps, acceptance criteria).
- `components.html`: a gallery of all of these components.

## Rules
- **Status is shown with dots, not fills.** `--status-waiting` (needs you), `running`, `done`, `failed`, `idle`, `local` (your session). Large coloured backgrounds are reserved for `destructive` buttons.
- Use **one primary button per card**, for the main action (Approve, Open review packet). Other actions are outline or ghost.
- "Needs you" cards get the `waiting` ring (`--shadow-ring-waiting`).
- Use mono type for ids, times, branches and runner names.
