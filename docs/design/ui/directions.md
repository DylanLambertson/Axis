# Axis UI: three design directions

- **Status:** proposal for the owner's decision. Nothing here is implemented in the product.
- **Date:** 2026-11-05
- **Inputs:** `docs/UX.md` (design thesis and provisional tokens), `docs/PRODUCT.md`, `docs/design/axis-shell.md` and `axis-shell-stage1-built.md`, `assets/brand/`, the Axis themes in `code-oss/overlay/extensions/theme-axis/themes/`, and the Axis shell sources in `code-oss/overlay/src/vs/axis/browser/` (`workbench.ts`, `parts/agentPart.ts`, `parts/media/agentPart.css`).
- **Deliverables in this folder:** this file; `mockup-b.html` and `mockup-c.html` (standalone, open them in a browser); `tokens.md` (the token set for the recommended direction). Direction A's mockup is the existing first mockup; it is described here and not copied into the repository.
- **Upstream facts.** Where this document says how something maps onto the Code OSS workbench, **[V]** means read in the pinned source (Code OSS `1.144.0`, `2c33b50b`) and **[I]** means inferred, not verified by running anything.

## 1. The problem

The owner's brief: Axis must feel like its own app, superior, futuristic and understandable, with Code OSS in the background. It must use the patterns people already know from current tools. It must not read as a barely working agent-management portal.

`docs/UX.md` already sets the guardrails: agent manager first; calm, dense and precise; accent colour only for meaning; no glows, gradient surfaces, metric walls or oversized cards; WCAG 2.2 AA; keyboard-first; motion of roughly 120–200 ms with reduced-motion support and no background loops.

So the question is not "calm or loud". It is how much of the product's identity comes from **structure and behaviour** (layout, glyphs, keyboard, timeline, transitions) and how much from **surface treatment** (depth, translucency, colour, gradients). Surface treatment is cheap in a mockup and expensive in Code OSS, because most of the IDE view is upstream DOM that Axis only themes.

### What users already know
Every direction keeps these patterns, because they are what makes a new tool feel familiar on day one:

- A command palette on `⌘K` / `Ctrl+K` that reaches every action, plus the upstream palette in IDE view.
- Keyboard-first lists: `J` / `K` to move, `Enter` to open, a letter for the primary action, hints shown next to the controls.
- A segmented control for the view (Agent, IDE, Split) that exposes its pressed state.
- Inline decisions in the place where the work happens (approval in the activity stream, accept and reject on each hunk), not modal interruptions.
- A breadcrumb that always says where you are: Dashboard › project › workspace › branch.
- Light and dark that follow the system, with a manual override.
- Status as text, with a shape and a colour, never colour alone.

## 2. Direction A: Restrained

The existing first mockup. Flat, full-bleed workbench panes divided by 1 px borders. One accent (the brand violet) for selection, focus and primary actions. The dashboard is a dense table grouped by project. Approvals and the protected-path flag use an amber border. Type is a single sans and mono pair at 12–14 px.

- **Strengths.** Closest to `docs/UX.md` as written. Lowest risk: it looks like the rest of the IDE view, so the switch between Agent view and IDE view is seamless. Cheapest to build.
- **Weaknesses.** It answers "calm" and "dense" but not "its own, futuristic". Next to other developer tools it reads as a well-made list with a sidebar: the risk the owner named. Nothing in it is memorable: no signature interaction, no visual element that says "Axis". Status dots are circles in different colours, so state relies more on colour than it should.

## 3. Direction B: Instrument

`mockup-b.html`. Axis as a precision instrument: the workbench is a set of floating tiles on a darker "void", like panels in a cockpit. It keeps the dense table and every Phase 1 behaviour, and adds a stronger visual language and a few signature interactions.

### 3.1 Visual language
- **Tiles on a void.** Every pane is a tile with a 10 px radius, separated from its neighbours by a 6 px gap that shows the darker window background. Tiles carry a 1 px inner top highlight and a soft shadow. The structure of the window becomes visible at a glance.
- **Cooler, deeper palette.** Neutrals tinted toward the brand violet (dark canvas `#0B0B12`, surface `#12131C`). The violet stays the interaction accent.
- **A second signal colour.** Teal (`#5FE3CF` dark, `#0B7A6E` light) means only "live": a run producing events now. Violet means "you can act on this"; amber means "needs you"; red means "failed".
- **The axis line.** The activity stream hangs on a vertical line that fades from violet to transparent: the brand's "axis" as a structural element. Each event is a node on it.
- **Guard band.** The protected-path flag has a striped hazard edge on its left side, plus a heading, the path, and an explanation of the consequence.

### 3.2 Typography
Geist for UI text and Geist Mono for code, paths, branch names and **micro-labels**: 10.5 px uppercase mono with 0.08 em tracking for section labels ("NEEDS YOU", "WORKTREE", "STEP 6"). Page titles at 20 px, weight 600, −0.02 em tracking. Numbers are tabular everywhere. Both families are under the SIL Open Font License 1.1; the product would bundle them rather than load them from the network.

### 3.3 Depth
Three levels: the void (window background), tiles (resting surface, soft shadow), and lifted objects (decision cards, the command palette). The palette is translucent with a background blur. Depth is used to say what can be acted on: the only lifted object in a workspace is the pending decision.

### 3.4 Motion
All motion is triggered by an event; nothing loops.

- A view switch fades in and rises 3 px in 160 ms.
- A decision card scales from 0.98 to 1 in 200 ms when it arrives.
- When the user approves, the new event's node shows a one-shot violet ring (200 ms).
- Buttons move 1 px on press.

Under `prefers-reduced-motion: reduce` (and the workbench's own `workbench.reduceMotion`) every animation is removed and state changes are instant.

### 3.5 Signature interactions
1. **Workspace spine.** A narrow column on the far left with a monogram tile per workspace. Each tile carries a status glyph, and its accessible name gives the state ("Fix proration rounding, waiting for approval"). It is the dashboard in miniature, visible in every view; one click or the existing focus-workspace shortcut (`axis.workspace.focus.1` … `.9`) jumps to a workspace.
2. **"Needs you" lane.** The dashboard pins a lane above the projects with every workspace that needs the user, with the reason in text.
3. **Activity trace.** Each dashboard row has a 2-hour strip of event ticks. It is coloured by kind (event, live, waiting, failure) and has a text alternative ("12 events, 1 waiting"). It answers "is anything happening?" without a chart.
4. **Decision card.** The approval request shows action, scope and consequence, and has keyboard bindings shown on its buttons (`⌘↵` approve once, `⌘⌫` deny). Deciding replaces the card with a timeline event and moves focus to the composer.
5. **Review meter.** A row of pills in the review header shows each hunk's decision (accepted, rejected, undecided), with the count in text beside it.

### 3.6 Keeping density and accessibility
- Rows stay at 46 px with two lines of text. The spine costs 62 px of width, which the tile gaps partly pay back by replacing borders.
- Every status uses a distinct **shape**: running is a filled circle, waiting a diamond, failed a square, done a ringed dot, quiet a dashed ring, idle an empty ring. Each also has a text label. Shapes survive colour-vision deficiency and forced-colours mode.
- Text roles reach at least 4.5:1, and control boundaries at least 3:1, on every surface they sit on (key pairs: `#A3A6BC` on `#12131C` 7.69:1; `#A88FFF` on `#191A26` 6.60:1; `#6F7390` control borders 3.40:1 on the palette).
- The translucent palette never shows text over busy content: its background is 92% opaque.
- Focus is a 2 px accent outline with a 2 px offset, on every interactive element, never removed.

### 3.7 Where B departs from `docs/UX.md`
- It adds a gradient (the axis line) and a striped band.
- It adds translucency and shadows beyond "near-zero".
- It adds a second signal colour.
- It adds a spine, which is a new persistent part.

Each is deliberate, and each needs the owner's approval.

## 4. Direction C: Precise instrument (hybrid)

`mockup-c.html`. A's flat, full-bleed, bordered workbench, so Agent view and IDE view stay one continuous surface. It adds the parts of B that carry **meaning and behaviour** and leaves out the parts that are only surface.

**From B, kept:**
- The timeline axis in the activity stream, drawn as a neutral 1 px line with event nodes. It has no gradient.
- The status glyph system (one shape per state) and its text labels.
- Mono micro-labels for section headers.
- Keyboard hints next to primary actions, `J` / `K` on the dashboard, and `⌘↵` on the decision card.
- A lifted layer used only for the pending decision and for overlays (palette, menus). Everything else is flat.
- Event-driven motion: a 160 ms fade on view switch, a 200 ms lift when a decision arrives, a one-shot accent mark on a new event, and nothing under reduced motion.
- A protected-path flag with a heavy 4 px amber left edge (instead of stripes), a heading, the path and its consequence.
- A 2 px left edge on dashboard rows that need the user (amber) or failed (red), in addition to glyph and text.

**From B, left out:**
- Tiles on a void.
- Translucency and blur.
- The teal live colour: running uses the accent, as in A.
- The spine: the top bar's activity indicator and the dashboard cover it.
- The activity trace: it stays a candidate for a later "density" option once real event data exists.

**Adjusted tokens.** These are A's tokens with the contrast fixes from `tokens.md`:
- the dark `accent-text` becomes `#A386FA`, so violet text passes 4.5:1 on the overlay too;
- the dark `control-border` becomes `#757A84` (3:1 on the overlay);
- the light `control-border` becomes `#80858E` (3:1 on the hover background);
- the status colours are defined for both themes.

## 5. Decision table

| | A Restrained | B Instrument | C Precise instrument |
|---|---|---|---|
| **Feel** | Calm, competent, familiar; generic next to other developer tools | Distinctive, futuristic, "its own app"; strongest first impression | Calm and precise with a recognisable signature (timeline axis, glyphs, keyboard, lifted decisions) |
| **Risk to usability** | Low. Risk is in state legibility: colour-only dots | Medium. The spine and the trace add things to learn. Tile gaps and the void cost width at 1280 px. Translucency can hurt legibility under some wallpapers and in high contrast. Two signal colours to learn | Low. Every addition is a known pattern (timeline, glyph plus label, keyboard hints) |
| **Cost on Code OSS workbench parts** | Low: Axis agent part (own DOM) plus theme colours (already shipped in `theme-axis`) | High. Gaps between grid leaves need the Axis grid to inset every part. Rounded, shadowed tiles mean CSS overrides on upstream `.part` elements (title bar, sidebar, editor, panel, auxiliary bar, status bar), which upstream churn can break. The spine is a new part or an activity-bar replacement. Blur on quick input costs GPU on Electron | Low to medium: agent part (own DOM), theme colours, Axis-registered colour and size tokens, one small CSS file for overlays and radii |
| **Accessibility (WCAG 2.2 AA)** | Meets text and control contrast with the tokens in `docs/UX.md`. Status leans on colour (1.4.1 at risk). Some hunk buttons are 22 px tall (2.5.8 needs 24 px) | Meets contrast as specified. Shapes for status. Extra checks needed: text over translucency in every theme and wallpaper, forced colours (shadows and blur disappear, so tiles need borders), focus visibility on tiles | Meets contrast as specified in `tokens.md`, with status shapes and 24 px minimum targets. Flat surfaces behave well in forced colours |
| **Dark and light** | Both, from `docs/UX.md` | Both, but light mode loses much of the instrument feel (the void becomes pale grey) | Both, equal quality; the lifted layer works in both |
| **Consistency with IDE view** | High: same flat panes | Low unless every upstream part is restyled; otherwise Agent view and IDE view look like two apps | High: IDE view gets the same tokens, overlays and focus ring |

### 5.1 Implementation cost by part
The Axis shell owns the grid and the agent part, and reuses every upstream part as-is (`docs/design/axis-shell.md` §0.1, §1).

| Part | A | B | C |
|---|---|---|---|
| Axis agent part (`AgentPart`, `agentPart.css`) [V] | Axis DOM, Axis CSS | Same, plus tile chrome | Same, plus timeline and glyph styles |
| Title bar (`TITLEBAR_PART`; command center, `MenuId.TitleBar` items) [V] | Theme colours, custom view items for activity and view control | Rounded tile with gaps: CSS overrides on upstream title bar markup | Theme colours, custom view items |
| Activity bar, sidebar, panel, auxiliary bar, editor [V] | Theme colours | Inset by grid gaps and rounded: Axis grid change plus CSS overrides per part [I] | Theme colours; radii come from upstream size tokens |
| Quick input, menus, notifications, hovers [V] | Theme colours | Translucency and blur via CSS override [I] | `widget.shadow` theme colour plus overlay radius; no override |
| Status bar [V] | Theme colours | Tile chrome via CSS override | Theme colours |
| New parts | None | Spine (part or activity-bar replacement) | None |

## 6. Recommendation

**Adopt direction C.**

- It answers the brief with **behaviour and structure** rather than paint. A user knows within a minute what is running, what needs them and how to act, by keyboard. The timeline axis, glyph statuses and lifted decisions are what make it feel like a dedicated instrument and not a portal.
- It keeps Agent view and IDE view one continuous surface. Code OSS stays "in the background" because it is themed with the same tokens, not because Axis hides it behind chrome that the IDE view cannot match.
- It is the only distinctive direction that fits inside the shell budget (ADR 0002 criterion 2) without per-part CSS overrides of upstream markup.
- It meets WCAG 2.2 AA with margin in both themes, and the token set is ready (`tokens.md`).

Keep two elements of B as **candidates** for a later density setting, once real data exists to judge them: the workspace spine (for users who run many workspaces at once) and the activity trace (once the daemon reports event history). Neither is needed for Phase 1.

### 6.1 Validation before the owner signs off
1. A keyboard-only walkthrough of `docs/PRODUCT.md` scenarios 1–4 in the C mockup: every step reachable, focus always visible, focus returns after the palette and after a decision.
2. Screen reader passes (VoiceOver on macOS, NVDA on Windows). Check that statuses read as text, that the activity stream is announced as a log, and that view switches are announced.
3. Zoom to 200% and reflow at 1280 px window width; forced-colours (Windows high contrast); reduced motion on and off.
4. Contrast re-checked with `tokens.md` values after any token change.
5. A five-person comprehension test on the dashboard: "which workspace needs you, and why?" within 5 seconds.

## 7. Proposed changes to `docs/UX.md`

These are proposals only; `docs/UX.md` is unchanged in this branch. Each applies if the owner picks C. Most of them also apply to B.

1. **Visual tokens.** Change the dark `accent-on-dark` from `#9776F9` to `#A386FA`:
   - 6.56:1 on canvas and 5.03:1 on the overlay, where `#9776F9` gives 4.30:1 and fails 4.5:1 for text.
   - The theme's `focusBorder`, `textLink.foreground` and related keys follow.

   Change the dark `control-border` from `#6B7079` to `#757A84`, which gives 3.34:1 on the new overlay surface `#272A30`. Change the light `control-border` from `#8A8F98` to `#80858E`: the old value gives 2.96:1 on the hover background `#F4F4F6`.

   Add an `overlay` surface (dark `#272A30`) and the status colours with their light values:

   | Role | Light | Dark |
   |---|---|---|
   | ok | `#146C34` | `#4CC38A` |
   | warn | `#965506` | `#E5A33D` |
   | bad | `#C0262D` | `#F2777C` |
   | info | `#1D66C2` | `#6CA8F7` |

   The light ok `#17803D` used in the first mockup gives 4.45:1 on the diff-added background and fails 4.5:1. Full table in `tokens.md`.
2. **Status glyphs.** Add to the dashboard and Agent UX sections: each run state has its own shape and a text label. Running is a filled circle, waiting for approval a diamond, failed a square, done a ringed dot, quiet a dashed ring, idle an empty ring.
3. **Elevation rule.** Replace "near-zero shadows unless layering requires them" with three levels. Flat surfaces separated by borders; a lifted level used only for a pending decision in the activity stream; an overlay level for the palette, menus and notifications, with a scrim.
4. **Activity stream.** Events are nodes on a vertical timeline line. A decision appears in the stream at the point where the run stopped. Deciding replaces it with an event that records who decided what, and moves focus to the composer.
5. **Typography.** Replace "System/Inter-like UI sans" with a bundled Geist / Geist Mono pair (SIL OFL 1.1), falling back to the system UI font. Add the mono micro-label style (11 px, uppercase, 0.06 em tracking) for section labels only. Adopt the type scale in `tokens.md`.
6. **Targets.** Make 24 × 24 px the minimum target for any control (WCAG 2.2 SC 2.5.8), including per-hunk accept and reject.
7. **Focus.** The focus indicator is a 2 px `accent-text` outline with a 2 px offset (inset by 2 px inside lists and tables), at least 3:1 against adjacent colours, and never hidden by a sticky header or the composer (SC 2.4.11).
8. **Motion.** Name the three durations (120, 160, 200 ms) and the ease-out curve. All motion is triggered by an event. Under reduced motion, durations become 0 and no transform is applied.
9. **Keyboard hints.** Primary actions show their shortcut on the control. The dashboard supports `J` / `K` / `Enter` and `N` for a new workspace; these are single-key bindings scoped to the dashboard list, and are re-checked against upstream bindings in shell task A6 like the others.
