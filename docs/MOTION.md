# Motion

Presentation only. Beautiful and cheap: only `opacity`, `translate`, `scale`, `rotate` (the individual transform properties, so they compose and animate independently) plus background/colour on small elements. Source: `app/motion.css` (tokens in `app/globals.css`, washes/glows in `app/theme.css`). Gallery: `/ui-preview/motion` (`?theme=dark`). Contract: `tests/motion-contract.test.ts`.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--motion-fast / base / slow` | 120 / 180 / 260ms | colour fades, small state changes |
| `--dur-press` | 70ms | press-down (ease-in `--ease-press`) |
| `--dur-release` | 240ms | spring release (`--ease-pop`, overshoot) |
| `--dur-enter` | 200ms | page content, popovers, dialogs enter |
| `--dur-first` | 160ms | first-load content (until `html[data-cg-nav]`, set 1.5s after load) |
| `--dur-exit` | 100ms | popover/dialog exit, quieter than enter |
| `--dur-step` | 20ms | stagger step (max 6 steps, total 320ms) |
| `--ease-out / standard / in-out / out-expo / spring / pop / press` | see CSS | |
| `--btn-wash-*`, `--btn-glow-*`, `--btn-lift-*` (accent, neutral) | theme.css | button wash, pointer glow, grown shadow, per theme |

## Utilities

- `.cg-stagger` : children fade and rise (6px, from 15% opacity) with a 20ms stagger. `.app-content > *` roots get it automatically; nothing to add on routes.
- `.cg-enter` : mount-driven pop (fade, 4px, scale .97) for conditionally rendered surfaces.
- `.cg-pop` : on `[popover]` or `<dialog>`: enter 200ms, exit 100ms via `@starting-style` + `allow-discrete`. Set `--origin` for the transform origin. Unsupported browsers show/hide instantly.
- `.cg-sheet` : same for bottom sheets (14px slide, no scale).
- `.cg-skeleton` : put on a skeleton's root: fades in after a 120ms delay so fast loads never flash it.
- `.cg-still` : opt out (parent: its children stop animating; or on the element itself).
- `.cg-switch`, `.cg-checkbox` (on `<input type=checkbox>`): spring thumb, drawn check. `.cg-chevron` (rotates when an ancestor has `aria-expanded="true"` or `[open]`), `.cg-arrow` (nudges 2px on button/link hover), `.cg-check` (SVG stroke draws).
- `.button` : layered: `::before` wash with a pointer-aware radial glow (`--mx/--my`, set by one delegated rAF-throttled listener in `shell-effects.tsx`, mouse and `(hover:hover)` only), `::after` grown shadow (opacity only), 1px lift on primary/secondary, press `scale(.965)` in 70ms and a 240ms overshoot release, a focus ring that grows in, `aria-busy="true"` swaps the leading icon for a spinner. Disabled buttons never move.

## Skeleton to content hand-off

Suspense swaps the DOM, so there is no crossfade between the two trees. Skeletons fade in after 120ms (fast loads never show one) and the view-transition `skeleton-in` fade is disabled so it is not applied twice. Content starts at 15% opacity, not 0, on an expo-out curve (about 60% visible at 60ms), so the swap never reads as an empty frame, and rises only 6px. The route-level view transition is opacity-led (no blur) and the CSS stagger supplies the motion.

## Where we deliberately do not animate

- Dense table/list rows, sidebar nav, bottom tab bar items: 90ms background fade only. Lists must feel instant and may be virtualised.
- Command palette highlight: 70ms move (was a 260ms glide). Keyboard navigation (J/K, arrows, roving focus) never gets a travelling highlight.
- Quiz answers and question navigation: 90ms colour change, tiny press. Time-sensitive.
- Disabled controls, and destructive tiny text buttons (`.danger-button`): colour only.
- Tooltips and toasts: no entrance delay; keep any fade under 150ms.
- Repeated rapid actions and anything inside a long list: no per-item entrance.
- Layout properties (width/height/top/left/margin/padding): never. One documented exception allowed by marking the line `/* cg-allow-layout */`.

## Reduced motion

`prefers-reduced-motion: reduce`: no translate/scale/rotate, no glow or shimmer, no spinner rotation; page content and skeletons keep a 100ms opacity fade; view transitions are instant. Focus rings stay fully visible. Hover effects exist only under `(hover:hover)`; touch devices get press feedback only.

## Rules for contributors

1. Use tokens for durations and easings; no `transition: all`; list properties explicitly.
2. Animate only opacity and the transform properties. Grow shadows through a pseudo-element's opacity.
3. No global `will-change`. Hover-only effects go inside `@media (hover:hover)`.
4. Colours come from theme tokens; add new washes to both themes in `theme.css`.
5. New moving CSS needs a reduced-motion rule; run `npx tsx --test tests/motion-contract.test.ts`.
6. Stagger page content with `.cg-stagger`; do not put your own `animation` on a page root.
