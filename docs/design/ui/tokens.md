# Axis UI tokens: proposal for direction C

- **Status:** proposal; it applies only if the owner picks direction C (`directions.md` §7). Nothing here is implemented, and `docs/UX.md` stays the source of truth until the owner accepts the changes listed in `directions.md` §8.
- **Date:** 2026-11-05
- **Used by:** `mockup-c.html` and `mockup-c.css` (the same values, under shorter mockup names).
- **Contrast method:** WCAG 2.x relative luminance, computed for each pair below rather than estimated. Text needs at least 4.5:1 (SC 1.4.3); component boundaries, focus indicators and status glyphs need at least 3:1 (SC 1.4.11).
- **Upstream facts:** **[V]** means read in the pinned Code OSS source (`1.144.0`, `2c33b50b`); **[I]** means inferred.

## 1. Tokens as CSS custom properties

The `--ax-` names are the design vocabulary. Section 6 says where each one comes from in the product: the agent part never hard-codes these values, it reads workbench variables.

```css
/* Light. Values change only by theme; every other token is theme-independent. */
:root {
  /* surfaces */
  --ax-canvas: #FAFAFB;       /* window, title bar, activity bar, status bar */
  --ax-surface: #FFFFFF;      /* panes: agent view, editor, sidebar, panel */
  --ax-raised: #FFFFFF;       /* cards in a pane: dashboard groups, diff files, decision card */
  --ax-overlay: #FFFFFF;      /* palette, menus, notifications, hovers */
  --ax-hover: #F4F4F6;        /* row and control hover */
  --ax-line: #E5E7EB;         /* decorative separators only, never a control boundary */
  --ax-control-border: #80858E; /* inputs, secondary buttons, segmented controls */
  /* text */
  --ax-text: #17191D;
  --ax-text-2: #50555F;       /* secondary text, placeholders, line numbers */
  --ax-text-disabled: #6B7280; /* disabled only */
  /* accent (brand violet, hue 255) */
  --ax-accent: #5823F6;       /* filled primary controls; label is #FFFFFF */
  --ax-accent-hover: #4A1AD6;
  --ax-accent-text: #5823F6;  /* links, accent text, focus ring, selection edge */
  --ax-accent-soft: #EFEAFE;  /* selected row, active filter */
  /* status: always with a glyph shape and a text label */
  --ax-ok: #146C34;  --ax-warn: #965506;  --ax-bad: #C0262D;  --ax-info: #1D66C2;
  --ax-on-status: #FFFFFF;    /* label on a filled ok or bad control */
  --ax-warn-soft: #FFF4E0;    /* protected-path flag, decision header */
  --ax-diff-add: #E7F5EC;  --ax-diff-del: #FBE9EA;
  /* elevation */
  --ax-elev-1: 0 1px 2px #17191D0F;
  --ax-elev-2: 0 4px 12px #17191D14, 0 1px 3px #17191D0F;
  --ax-elev-3: 0 16px 48px #17191D29, 0 2px 8px #17191D14;
  --ax-scrim: #17191D33;
}
/* Dark (the default theme) */
:root[data-theme="dark"] {
  --ax-canvas: #111214;  --ax-surface: #181A1D;  --ax-raised: #202227;  --ax-overlay: #272A30;
  --ax-hover: #1F2125;   --ax-line: #2B2E34;     --ax-control-border: #757A84;
  --ax-text: #E8E9EB;    --ax-text-2: #9A9EA7;   --ax-text-disabled: #70757F;
  --ax-accent: #5823F6;  --ax-accent-hover: #4A1AD6;  --ax-accent-text: #A386FA;  --ax-accent-soft: #241C3F;
  --ax-ok: #4CC38A;  --ax-warn: #E5A33D;  --ax-bad: #F2777C;  --ax-info: #6CA8F7;
  --ax-on-status: #111214;  --ax-warn-soft: #2A2114;  --ax-diff-add: #14281D;  --ax-diff-del: #2D1719;
  --ax-elev-1: none;
  --ax-elev-2: 0 4px 12px #00000059;
  --ax-elev-3: 0 16px 48px #0000008C, 0 0 0 1px #FFFFFF0A;
  --ax-scrim: #00000066;
}
/* Theme-independent */
:root {
  --ax-font-ui: "Geist", system-ui, -apple-system, "Segoe UI", sans-serif;
  --ax-font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ax-text-xs: 11px;   --ax-lh-xs: 16px;   /* mono micro-label, uppercase, 0.06em tracking, weight 500 */
  --ax-text-sm: 12px;   --ax-lh-sm: 18px;   /* metadata, branch names, hunk headers, status bar */
  --ax-text-md: 13px;   --ax-lh-md: 20px;   /* body and controls (default) */
  --ax-text-lg: 14px;   --ax-lh-lg: 20px;   /* pane titles, weight 600 */
  --ax-text-xl: 18px;   --ax-lh-xl: 24px;   /* page title, weight 600, -0.01em */
  --ax-text-2xl: 22px;  --ax-lh-2xl: 28px;  /* empty-state heading only */
  --ax-code: 12.5px;    --ax-lh-code: 20px; /* editor and diff; user-selectable in settings */
  --ax-weight-regular: 400; --ax-weight-medium: 500; --ax-weight-semibold: 600;
  --ax-space-0-5: 2px; --ax-space-1: 4px; --ax-space-1-5: 6px; --ax-space-2: 8px; --ax-space-3: 12px;
  --ax-space-4: 16px;  --ax-space-5: 20px; --ax-space-6: 24px;  --ax-space-8: 32px;
  --ax-row-compact: 28px; --ax-row: 32px; --ax-row-two-line: 42px;
  --ax-control-sm: 24px;  /* minimum target, WCAG 2.2 SC 2.5.8 */
  --ax-control: 30px;     --ax-control-lg: 36px;
  --ax-radius-xs: 4px;  /* tags, keycaps, inline code */
  --ax-radius-sm: 6px;  /* buttons, inputs, rows, segmented controls */
  --ax-radius-md: 8px;  /* flags, small popovers */
  --ax-radius-lg: 10px; /* dashboard groups, diff files, decision card, composer */
  --ax-radius-xl: 12px; /* overlays: palette, dialogs */
  --ax-focus-width: 2px; --ax-focus-offset: 2px; /* -2px inside lists and tables */
  --ax-dur-instant: 0ms;  /* typing, command execution, palette results */
  --ax-dur-fast: 120ms;   /* hover, press, colour changes */
  --ax-dur-mid: 160ms;    /* view switch fade, overlay open */
  --ax-dur-slow: 200ms;   /* decision arrival, new-event mark */
  --ax-ease-out: cubic-bezier(.2, .8, .2, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --ax-dur-fast: 0ms; --ax-dur-mid: 0ms; --ax-dur-slow: 0ms; }
}
```

## 2. Colour roles and contrast

### 2.1 Dark theme
Each cell is the contrast ratio of the row's foreground on the column's background.

| Foreground | canvas `#111214` | surface `#181A1D` | raised `#202227` | overlay `#272A30` | hover `#1F2125` | accent-soft `#241C3F` | warn-soft `#2A2114` | diff-add `#14281D` | diff-del `#2D1719` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| text `#E8E9EB` | 15.43 | 14.35 | 13.10 | 11.84 | 13.27 | 13.17 | 13.04 | 12.80 | 13.85 |
| text-2 `#9A9EA7` | 6.98 | 6.50 | 5.93 | 5.36 | 6.01 | 5.96 | 5.90 | 5.79 | 6.27 |
| text-disabled `#70757F` | 4.05 | 3.77 | 3.44 | 3.11 | 3.49 | 3.46 | 3.42 | 3.36 | 3.64 |
| accent-text `#A386FA` | 6.56 | 6.10 | 5.57 | 5.03 | 5.64 | 5.60 | 5.54 | 5.44 | 5.89 |
| ok `#4CC38A` | 8.46 | 7.87 | 7.18 | 6.49 | 7.28 | 7.22 | 7.15 | 7.02 | 7.60 |
| warn `#E5A33D` | 8.60 | 8.00 | 7.30 | 6.60 | 7.40 | 7.34 | 7.27 | 7.13 | 7.72 |
| bad `#F2777C` | 6.88 | 6.40 | 5.84 | 5.28 | 5.92 | 5.87 | 5.81 | 5.70 | 6.17 |
| info `#6CA8F7` | 7.66 | 7.13 | 6.50 | 5.88 | 6.59 | 6.54 | 6.47 | 6.35 | 6.88 |
| control-border `#757A84` | 4.35 | 4.05 | 3.69 | 3.34 | 3.74 | 3.71 | 3.67 | 3.61 | 3.90 |
| line `#2B2E34` | 1.38 | 1.28 | 1.17 | 1.06 | 1.18 | 1.18 | 1.16 | 1.14 | 1.24 |

### 2.2 Light theme

| Foreground | canvas `#FAFAFB` | surface `#FFFFFF` | raised `#FFFFFF` | overlay `#FFFFFF` | hover `#F4F4F6` | accent-soft `#EFEAFE` | warn-soft `#FFF4E0` | diff-add `#E7F5EC` | diff-del `#FBE9EA` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| text `#17191D` | 16.87 | 17.60 | 17.60 | 17.60 | 16.02 | 14.98 | 16.15 | 15.65 | 15.04 |
| text-2 `#50555F` | 7.18 | 7.48 | 7.48 | 7.48 | 6.81 | 6.37 | 6.87 | 6.65 | 6.40 |
| text-disabled `#6B7280` | 4.63 | 4.83 | 4.83 | 4.83 | 4.40 | 4.11 | 4.44 | 4.30 | 4.13 |
| accent-text `#5823F6` | 6.74 | 7.03 | 7.03 | 7.03 | 6.40 | 5.98 | 6.45 | 6.25 | 6.01 |
| ok `#146C34` | 6.24 | 6.51 | 6.51 | 6.51 | 5.93 | 5.54 | 5.98 | 5.79 | 5.57 |
| warn `#965506` | 5.59 | 5.84 | 5.84 | 5.84 | 5.31 | 4.97 | 5.35 | 5.19 | 4.99 |
| bad `#C0262D` | 5.66 | 5.90 | 5.90 | 5.90 | 5.38 | 5.02 | 5.42 | 5.25 | 5.05 |
| info `#1D66C2` | 5.39 | 5.63 | 5.63 | 5.63 | 5.12 | 4.79 | 5.16 | 5.00 | 4.81 |
| control-border `#80858E` | 3.55 | 3.71 | 3.71 | 3.71 | 3.38 | 3.16 | 3.40 | 3.30 | 3.17 |
| line `#E5E7EB` | 1.19 | 1.24 | 1.24 | 1.24 | 1.13 | 1.05 | 1.14 | 1.10 | 1.06 |

### 2.3 Filled controls

| Label on fill | Ratio | Use |
|---|---:|---|
| `#FFFFFF` on accent `#5823F6` | 7.03 | Primary button, pressed view control, both themes |
| `#FFFFFF` on accent-hover `#4A1AD6` | 8.71 | Primary button hover |
| `#111214` on ok `#4CC38A` (dark) | 8.46 | Pressed "Accept" on a hunk |
| `#111214` on bad `#F2777C` (dark) | 6.88 | Pressed "Reject" on a hunk |
| `#FFFFFF` on ok `#146C34` (light) | 6.51 | Pressed "Accept" on a hunk |
| `#FFFFFF` on bad `#C0262D` (light) | 5.90 | Pressed "Reject" on a hunk |

### 2.4 Rules the numbers imply
- **Text roles pass 4.5:1 on every background they can sit on.** This covers `text`, `text-2`, `accent-text` and the four status colours. The changes from `docs/UX.md` that make this true:
  - dark `accent-text` is `#A386FA`: the old `#9776F9` gives 4.30:1 on the overlay;
  - light ok is `#146C34`: the first mockup's `#17803D` gives 4.45:1 on diff-add;
  - light warn is `#965506`: the first mockup's `#A15C07` gives 4.41:1 on accent-soft, so a warning in a selected row would fail.
- **`text-disabled` is for disabled controls only.** It fails 4.5:1 on several backgrounds, which SC 1.4.3 allows for inactive components. It is never used for placeholders, timestamps or line numbers: those use `text-2`. This is stricter than the first mockup, which used the muted colour for timestamps.
- **`control-border` passes 3:1 on every background**, so any input, secondary button or segmented control is identifiable (SC 1.4.11). `line` is decorative and is never the only boundary of a control.
- **The primary button in dark mode.** The accent fill on the dark canvas is 2.67:1. The button is identified by its white label (7.03:1) and its position, not by the fill edge. This matches the WCAG understanding of SC 1.4.11 for text buttons; review it with the accessibility pass.
- **Focus ring.** It is `accent-text`: 6.56:1 on the dark canvas and 6.74:1 on the light canvas, at least 5:1 on every surface, and 2 px wide. Inside a selected row, the ring sits on `accent-soft` (5.60:1 dark, 5.98:1 light).
- **Status glyphs** are non-text graphics and need 3:1. The weakest pairs are warn on light accent-soft (4.97:1) and the quiet glyph, drawn in `text-2`, on dark overlay (5.36:1).

## 3. Type, spacing, radii

**Type scale.** Six steps (section 1). Body is 13 px and 20 px line height, which matches upstream `bodyFontSize` (13 px) [V]. Mono is reserved for code, paths, branch names, commands, keycaps and micro-labels. Numbers use `font-variant-numeric: tabular-nums`. Headings never exceed 18 px inside a pane; 22 px is only for empty states. The product bundles the fonts (SIL OFL 1.1) and never loads them from the network; mockups use Google Fonts only for convenience.

**Spacing.** A 4 px grid. The workspace view uses:

| Element | Spacing |
|---|---|
| Pane padding | 12–18 px |
| Gap between rows in the activity stream | 8–10 px |
| Gap between cards | 12 px |
| Gap between dashboard groups | 14–16 px |

Row heights:

| Row | Height |
|---|---|
| Tree row | 24 px |
| List row | 28 px |
| Dashboard row (two lines) | 42 px |

The 42 px dashboard row is within "28–34 px compact rows" for single-line rows in `docs/UX.md`; two-line rows are new.

**Radii.** These follow `docs/UX.md`'s 6–8 px for controls and add 10 px for cards and 12 px for overlays. The window corner is the OS's.

## 4. Elevation

| Level | Token | Used for | Dark | Light |
|---|---|---|---|---|
| 0, flat | none | Panes, rows, lists, the activity stream | Surface steps and `line` borders | Same |
| 1, resting card | `--ax-elev-1` | Dashboard groups, diff files | None: dark relies on the `raised` step | 1 px soft shadow |
| 2, lifted | `--ax-elev-2` | **Only** the pending decision card in the activity stream | Shadow plus a warn border | Same |
| 3, overlay | `--ax-elev-3` and `--ax-scrim` | Palette, menus, dialogs, notifications | `overlay` surface plus shadow plus a 1 px light rim | Shadow |

A lifted object always means "this needs a decision". In forced-colours mode, shadows disappear; levels 2 and 3 keep a border (`control-border` or `warn`), so they stay distinct.

## 5. Motion

| Token | Duration | Used for |
|---|---|---|
| `--ax-dur-instant` | 0 ms | Typing, palette filtering, command execution, focus moves |
| `--ax-dur-fast` | 120 ms | Hover, press and selection colour changes |
| `--ax-dur-mid` | 160 ms | View switch (opacity only, from 0.4 to 1), overlay open (opacity, 4 px rise) |
| `--ax-dur-slow` | 200 ms | A decision card arriving; the one-shot mark on a new event's node |

Rules:
- Ease-out (`--ax-ease-out`) for everything.
- No loops: running state is a static glyph, never a spinner or pulse.
- Input is never blocked during a transition.
- Under reduced motion, durations become 0 and no transform is applied.

In the product, "reduced motion" means either the OS setting or upstream `workbench.reduceMotion`. Upstream's accessibility service toggles `monaco-reduce-motion` / `monaco-enable-motion` on the workbench container [V, `accessibilityService.ts:86-87`]. Axis CSS keys off that class, not only the media query.

## 6. Mapping onto Code OSS and the Axis shell

The pinned Code OSS turns every registered colour into a CSS variable: `asCssVariableName` replaces dots with dashes, so `editor.background` becomes `--vscode-editor-background` [V, `platform/theme/common/colorUtils.ts:35`]. Registered sizes work the same way [V, `platform/theme/common/sizeUtils.ts:45`]. `colorThemeCss.ts` writes both sets onto the workbench [V]. The mapping therefore has three layers:

1. **Roles that upstream already has:** set the existing theme keys in `theme-axis/themes/axis-{dark,light}.json` (table 6.1). IDE view, quick input, menus and notifications pick them up with no Axis code.
2. **Roles upstream lacks:** register Axis colours with `registerColor('axis.<role>', { dark, light, hcDark, hcLight }, …)` in Axis code. They then appear as `--vscode-axis-<role>`, can be overridden by any theme and by `workbench.colorCustomizations`, and get high-contrast defaults (table 6.2).
3. **Sizes:** use upstream size tokens where the value matches (table 6.3). Register `axis.*` sizes for the rest. Motion durations are plain CSS custom properties on `.monaco-workbench` in an Axis stylesheet, set to 0 under `.monaco-reduce-motion`.

The agent part keeps reading only `--vscode-*` variables, as `agentPart.css` does today:
- `--vscode-editor-background` and `--vscode-foreground`;
- `--vscode-descriptionForeground`;
- `--vscode-panel-border`;
- `--vscode-button-border`;
- `--vscode-toolbar-hoverBackground`;
- `--vscode-focusBorder`.

### 6.1 Roles mapped to existing theme keys

| Token | Theme keys (current `theme-axis` keys first) | Change against the shipped theme |
|---|---|---|
| canvas | `titleBar.activeBackground`, `titleBar.inactiveBackground`, `activityBar.background`, `statusBar.background`, `statusBar.noFolderBackground` | None |
| surface | `editor.background`, `sideBar.background`, `panel.background`, `terminal.background`, `editorGroupHeader.tabsBackground`, `tab.activeBackground`, `tab.inactiveBackground`, `sideBarSectionHeader.background`, `commandCenter.background`, `input.background` | None |
| raised | `button.secondaryBackground`, `checkbox.background`, `dropdown.background`, `badge.background`, `keybindingLabel.background` | None |
| overlay | `editorWidget.background`, `quickInput.background`, `menu.background`, `notifications.background`, `notificationCenterHeader.background`, `editorHoverWidget.background` | Dark: from `#202227` to `#272A30`, so overlays separate from raised cards |
| hover | `list.hoverBackground`, `toolbar.hoverBackground`, `commandCenter.activeBackground` | Dark: from `#202227` to `#1F2125` |
| line | `panel.border`, `sideBar.border`, `titleBar.border`, `statusBar.border`, `activityBar.border`, `editorGroup.border`, `tab.border`, `widget.border`, `menu.border`, `notifications.border`, `commandCenter.border`, `sideBarSectionHeader.border` | None |
| control-border | `input.border`, `checkbox.border`, `dropdown.border` | Dark `#6B7079` to `#757A84`; light `#8A8F98` to `#80858E` |
| text | `foreground`, `editor.foreground`, `tab.activeForeground`, `titleBar.activeForeground`, `list.activeSelectionForeground`, `input.foreground`, `menu.foreground`, `quickInput.foreground` and the other primary-text keys | None |
| text-2 | `descriptionForeground`, `icon.foreground`, `tab.inactiveForeground`, `statusBar.foreground`, `commandCenter.foreground`, `input.placeholderForeground`, `editorLineNumber.activeForeground` | None |
| text-disabled | `disabledForeground` | Move `editorLineNumber.foreground` from muted to `text-2` (line numbers are read, so they need 4.5:1) |
| accent | `button.background`, `activityBarBadge.background`, `statusBarItem.remoteBackground` | None |
| accent-hover | `button.hoverBackground` | None |
| accent-text | `focusBorder`, `textLink.foreground`, `textLink.activeForeground`, `list.focusOutline`, `inputOption.activeBorder`, `activityBar.activeBorder`, `tab.activeBorderTop`, `panelTitle.activeBorder`, `progressBar.background`, `sash.hoverBorder` | Dark: `#9776F9` to `#A386FA` |
| accent-soft | `list.activeSelectionBackground`, `list.inactiveSelectionBackground`, `menu.selectionBackground`, `quickInputList.focusBackground` | Use the opaque token in place of `#9776F926` (dark) / `#5823F614` (light), so the contrast in §2 holds exactly |
| ok, warn, bad, info | `errorForeground`, `editorError.foreground`, `editorWarning.foreground`, `editorInfo.foreground`, `gitDecoration.addedResourceForeground`, `gitDecoration.modifiedResourceForeground`, `gitDecoration.deletedResourceForeground`, `testing.iconPassed`, `testing.iconFailed` | Align with the status tokens (today `#F48771`, `#F14C4C`, `#CCA700` and `#59A4F9` in dark) |
| diff-add, diff-del | `diffEditor.insertedLineBackground`, `diffEditor.removedLineBackground` | New in `theme-axis`. Keep the upstream `diffEditor.insertedTextBackground` and `removedTextBackground` translucent overlays on top |
| elev-3 | `widget.shadow` [V, `editorColors.ts:339`] | Set per theme |

### 6.2 Roles registered by Axis

| Colour id (proposed) | CSS variable | Default (dark / light) | Used by |
|---|---|---|---|
| `axis.warnBackground` | `--vscode-axis-warnBackground` | `#2A2114` / `#FFF4E0` | Protected-path flag, decision header |
| `axis.status.running` | `--vscode-axis-status-running` | `accent-text` | Running glyph |
| `axis.status.waiting` | `--vscode-axis-status-waiting` | `warn` | Waiting glyph, needs-you row edge, decision border |
| `axis.status.failed` | `--vscode-axis-status-failed` | `bad` | Failed glyph, failed row edge |
| `axis.status.done` | `--vscode-axis-status-done` | `ok` | Done glyph |
| `axis.status.quiet` | `--vscode-axis-status-quiet` | `text-2` | Quiet glyph (dashed) |
| `axis.timeline.line` | `--vscode-axis-timeline-line` | `line` | Activity stream axis |
| `axis.timeline.node` | `--vscode-axis-timeline-node` | `surface` | Event node fill |

High-contrast defaults for every row: `contrastBorder` for lines and node borders, `contrastActiveBorder` for running and waiting, and the upstream high-contrast error and warning colours. Each default references the existing colour id rather than a literal, so a theme that changes `focusBorder` or `errorForeground` carries Axis with it [I].

### 6.3 Sizes

| Token | Upstream size (default) [V, `baseSizes.ts`] | Axis action |
|---|---|---|
| radius-xs 4 px | `cornerRadius.small` (4 px) | Use |
| radius-sm 6 px | `cornerRadius.medium` (6 px) | Use |
| radius-md 8 px | `cornerRadius.large` (8 px) | Use |
| radius-lg 10 px | none | Register `axis.cornerRadius.card` |
| radius-xl 12 px | `cornerRadius.xLarge` (12 px) | Use |
| space-0-5 to space-8 | `spacing.size20` … `spacing.size320` (2–32 px) | Use |
| text-xs / sm / md | `bodyFontSize.xSmall` (11 px), `bodyFontSize.small` (12 px), `bodyFontSize` (13 px) | Use |
| text-xl 18 px | `fontSize.heading2` (18 px) | Use |
| text-lg 14 px, text-2xl 22 px | none (`fontSize.heading1` is 26 px) | Register `axis.fontSize.title` and `axis.fontSize.empty` |
| font weights | `fontWeight.regular` (400), `fontWeight.semiBold` (600) | Use; register `axis.fontWeight.medium` (500) |
| focus width | `strokeThickness` (1 px) is too thin | Axis CSS uses 2 px (§2.4) |

Upstream registers sizes with one value for all themes (`sizeForAllThemes`) [V]. Whether a colour theme file can override a size was not established; Axis should treat sizes as product constants, not theme data [I].

### 6.4 Axis shell parts

| Part or file | What changes when C is adopted |
|---|---|
| `parts/media/agentPart.css` [V] | Keeps its `--vscode-*` reads. Adds the radius, spacing and motion variables. Split header buttons use `--vscode-input-border` (control-border) instead of `--vscode-button-border` / `--vscode-panel-border`, because the panel border is decorative and below 3:1. The focus outline becomes 2 px instead of 1 px |
| Agent part content (dashboard, workspace, review; future) | Built from the tokens above, with glyphs from `axis.status.*` and the timeline from `axis.timeline.*` |
| Split header (`axis-split-header`) [V] | Height 32 px (`--ax-row`), micro-label for the title |
| `theme-axis/themes/*.json` [V] | The changes in table 6.1. The syntax files are unchanged |
| Upstream parts (title bar, activity bar, sidebar, editor, panel, auxiliary bar, status bar) [V] | Theme keys only; no CSS overrides of upstream markup |
| Quick input, menus, notifications [V] | `overlay`, `widget.shadow` and upstream radii; no blur |

## 7. Components of the project-level screens

These screens use no new colour values. They reuse the roles above, so every contrast figure comes from §2.

| Component | Tokens | Contrast and non-colour cue |
|---|---|---|
| Navigation rail (72 px, Agent view) | `surface`; item text `text-2`; current item `accent-soft` with a 2 px `accent-text` edge; 11 px label under a 15 px icon | Labels 6.50:1 (dark) and 7.48:1 (light); current item text 13.17:1 and 14.98:1. Current page is also `aria-current="page"` in the product (`true` in the mockup) and marked by the edge, not by colour alone |
| Agent avatar | 24 px, `radius-sm`, monogram in `--ax-font-mono` 10 px weight 600; composer: `accent-soft` fill; CLI: `surface` fill with a dashed `control-border` edge | Monogram 13.17:1 and 14.98:1. Type is also written next to the name ("Composer · Agent", "shipit · CLI agent"); shape only repeats it |
| Thread message | Sender in weight 600, `→`, receiver in `text-2`, time in mono `text-2`; relay state as a footer line in `text-2` | Every state is text: "Relayed by Axis · delivered", "not relayed", "Stopped by you" |
| Message not relayed | `bad` 1 px border, body struck through in `text-2`, a "not relayed" pill with the failed glyph, the reason as a sentence, and one action | Border 6.40:1 and 5.90:1 on surface. The strikethrough is never the only cue |
| Relay banner | `surface`, 3 px `accent-text` left edge, bold first sentence | Text 14.35:1 and 17.60:1 |
| Permissions card | ✓ in `ok`, ✕ in `bad`, sentence in `text`; visually hidden "Can:" or "Cannot:" before each sentence | Glyphs 7.87:1 / 6.51:1 (✓) and 6.40:1 / 5.90:1 (✕) on surface; meaning is in the words |
| Budget meter | Track `hover` with a 1 px `control-border` inset; fill `accent-text`; percentage and amounts as text beside it; `role="img"` with a label in the mockup (`progressbar` with value attributes in the product) | Fill against track 5.64:1 (dark) and 6.40:1 (light); track edge 4.05:1 and 3.71:1 on surface |
| Destructive button ("Stop thread", "Disconnect") | `bad` text and 1 px `bad` border on `surface`; hover `hover` | 6.40:1 and 5.90:1. The verb is explicit |
| Code panel editor | `--ax-font-mono` 12.5/20 px, `canvas` background, `control-border` edge, `radius-sm`; in the product, the upstream editor widget with the `editor.*` theme keys of §6.1 | Text 15.43:1 and 16.87:1; focus ring as §2.4; unsaved state is a pill with text ("unsaved", "saved") |

Mapping: the rail, lists, cards, thread and code panel are all Axis DOM inside the agent part (§6.4). The code panel's editor is the one exception: it is an upstream editor instance, so it is themed by the theme keys alone [I].

## 8. Open points for the owner
- Do you accept Geist and Geist Mono as the bundled UI fonts, or prefer the system UI font with a bundled mono?
- Should the light theme be equal in priority to dark? Both are specified to the same standard here.
- Should the accent stay user-configurable (`docs/UX.md` says it is)? If so, Axis must validate a user accent against the contrast table at runtime or derive `accent-text` from it.
- Should composer agents and CLI agents share one avatar style, with type in text only? The mockups add a shape difference (rounded or dashed square).
