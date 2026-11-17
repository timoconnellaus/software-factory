# ADR 0662: Motion is rare, fast and names its purpose

Status: accepted and built, 2026-11-18.

## Context
The desktop app's shadcn components (dialogs, popovers, menus, tooltips) already animated, with
Tailwind's weak default curves. The app's own surfaces did not: the item panel and the run modal
appeared at once, a collapsed section snapped open, and a button gave no sign it was pressed. The
app is used all day, which argues for little motion.

## Decision
1. **A thing animates only for a named purpose**: feedback, showing where something came from,
   making a state change readable, or bridging a change that would otherwise jump. Nothing moves
   for decoration.
2. **What a key opens many times a day does not animate.** Search (⌘K) shows and goes at once
   (`DialogContent`'s `instant`). Hover states, tabs and sidebar rows stay as they are.
3. **Under 300ms, on `transform` and `opacity`.** A press is 150ms; what enters is 200ms. The one
   exception is a collapsible's height, which has no transform equivalent.
4. **One set of curves**, in `packages/ui/src/styles/globals.css`: `--ease-out` for what enters or
   leaves, `--ease-in-out` for what moves on screen, `--ease-drawer` for a sheet. They replace
   Tailwind's `ease-out` and `ease-in-out`, so the shadcn components take them too.
5. **Reduced motion keeps the fades and drops the movement**, in one rule in `globals.css`.
6. **CSS only** (`tw-animate-css`, transitions). No motion library until something needs a spring,
   a layout animation or an exit the CSS can't do.

What animates today: a button's press (scale 0.97), the item panel (in from the right), the run
modal (fade and zoom, as the dialogs do), a collapsible (height), and a chat's live step lines.

## Not done
A card moving between columns when its status changes still jumps. Bridging it needs a layout
animation (rule 6), and is left until it is asked for.
