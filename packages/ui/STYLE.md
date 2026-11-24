# Caveman Code UI Tokens & Guidelines

Design tokens and styling primitives for `apps/web`, `apps/mobile`, and `packages/ui` live in `src/styles/pixel.css` and `tailwind-preset.cjs`.

## Core Principles

1. **Concise by default.** Every label, icon, badge, heading, and menu item should earn its place.
2. **Compact density.** Default chrome uses 13px typography and tight vertical rhythm so workspaces and diffs stay front and center.
3. **Consistent controls.** Reuse shared primitives from `packages/ui` across desktop, web, and mobile rather than introducing one-off treatments.
4. **Flat surfaces.** Reserve elevation and glass effects for floating surfaces (`Cmd+K`, popovers, menus, tooltips, dialogs); keep pages and panels flat.
5. **Immediate feedback.** Reflect user actions in the first frame without placeholder transitions.
6. **Respect user layout.** Never hijack scroll position, split panes, or model selection under the user.
