# @software-factory/ui

shadcn/ui components (new-york, zinc) and the factory theme, for `apps/app`. The theme follows
[`.kim/design-system/`](../../.kim/design-system/): zinc neutrals, Geist and Geist Mono, light and
dark from the system setting, and the factory **status tokens** (`waiting`, `running`, `done`,
`failed`, `idle`, `local`) used as dots (`<StatusDot status="waiting" />`), never as fills.

```css
/* the app's styles.css */
@import "@software-factory/ui/globals.css";
@source "./";
```

Add a component with `pnpm dlx shadcn@latest add <name>` from this folder, then fix its imports to
`@software-factory/ui/...`. Components started from the Relationship OS set.
