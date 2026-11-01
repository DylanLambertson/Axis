# UX and Visual Design System

## Design thesis
Cursor/Linear-inspired precision with a distinct original identity. Minimal, dense where useful, calm by default. Accent color and boldness signal interaction, selection, focus, or meaningful status—not decoration. No gratuitous glows, gradient-heavy surfaces, persistent dashboards, or oversized cards.

## Visual tokens (provisional, brand-neutral)
Dark default: canvas `#111214`, surface `#181A1D`, raised `#202227`, border `#2B2E34`, primary text `#E8E9EB`, secondary `#9A9EA7`, muted `#70757F`. Light alternative: canvas `#FAFAFB`, surface `#FFFFFF`, border `#E5E7EB`, text `#17191D`. Interaction accent placeholder `#8B8CF8`—configurable, sparingly used. Status colors must meet contrast requirements and never be sole indicator.

## Typography and spacing
System/Inter-like UI sans with strong legibility; code font user-selectable. 12–13px dense controls, 13–14px standard UI, restrained headings. 4px spacing grid, 28–34px compact rows, 36–40px primary controls. Use consistent 6–8px corner radii; near-zero shadows unless layering requires them. These are starting tokens to validate through prototypes.

## Default layout
Top: compact project/workspace switcher, command/search, agent activity indicator, account/model control. Left: collapsible activity rail + explorer/search/Git. Center: editor tabs, splits, inline diff and preview. Right: optional contextual AI panel. Bottom: terminal/problems/output. Every panel is resizable, hideable, and keyboard navigable. Preserve user layout per workspace.

## AI UX
One unified composer with explicit mode: Ask, Edit, Agent. Model/account selector reveals only relevant capabilities. Inline edits appear as reversible diffs. Parallel agent activity collapses into a single status indicator until expanded. Approvals show exactly what action, scope, and consequence are requested.

## Agent UX
Compact task timeline by default; advanced DAG and worktree graph on demand. Avoid representing each agent as a permanent chat tab. Review queue is centered on code changes, tests, and merge readiness. Show real errors, waiting states, provider limitations, and recovery actions.

## Team UX
Presence is subtle; remote cursors only when collaborating. Comments and review suggestions live with the file/diff. Shared agent activity respects permissions. Explicit separation between personal and team context.

## Motion
Fast, purposeful transitions (roughly 120–200ms), no animation on critical input latency, reduced-motion support, no background motion loops. Favor instantaneous command interactions.

## Accessibility
WCAG 2.2 AA target, keyboard-only workflows, focus visibility, screen-reader semantics, sufficient contrast, zoom scaling, reduced motion, no color-only statuses, command palette access to all essential actions.

## Design acceptance
A new user can open a repo and start editing without understanding orchestration. A power user can manage concurrent agents without leaving the editor. Primary actions remain discoverable in both compact and expanded states.
