# PV-V0 spike: an embedded editor in the side panel

- **Status:** Spike report for ticket PV-V0 (`product-vision-v2-tickets.md`). Input to PV-V2 and to the side-panel editor section that `axis-agent-shell.md` gains after this spike.
- **Date:** 2026-11-20. Upstream baseline: Code OSS `1.144.0`, commit `2c33b50`. Upstream paths are relative to `src/vs/` at that commit; `file:line` refers to it.
- **Question (product-vision-v2 §3.5 rule 1, §4):** can a real Code OSS editor widget live in an Axis part outside the editor part, over the same text model as IDE view, with sound focus routing, within the ADR 0002 criterion 2 budget (at most 12 upstream files and 300 lines)? If not, use the split-half fallback.

## 1. Recommendation

**Embed.** The widget, the shared model and every keyboard rule below work without one upstream change. The shell block stays at **8 upstream files** (§4), and the prototype is overlay-only. The rules that make it safe are not optional, though. Without them, Save in the side panel saves a different file and Close closes a hidden IDE editor (§3.2). PV-V2 builds on the prototype under these conditions:

1. The five routed keys and the Escape rule of §3 ship with the editor, keeping the tests that pin their weights.
2. The approval shortcut, when it is built, uses the card-scoped gate of §3.4 and is never a keybinding-service command.
3. The editor reads the user's `editor.*` settings and then forces the options of §5. A raw `CodeEditorWidget` does not read the settings itself.
4. **Re-check in the real workbench first.** PV-V2's first task runs the browser checks of §6 again in a packaged build, plus a screen-reader pass (§6.3 lists what this spike could not run). If a blocker appears there that cannot be fixed in the overlay, switch to the fallback (§7). It reuses existing mechanisms and also has a zero upstream footprint.

## 2. How the embed works

`AxisSidePanelEditor` (`code-oss/overlay/src/vs/axis/contrib/sidePanel/browser/axisSidePanelEditor.ts`) works like this:

- **Widget.** It creates a `CodeEditorWidget` with `instantiationService.createInstance`. It passes all registered editor contributions (`EditorExtensionsRegistry.getEditorContributions()`) and sets `isSimpleWidget: false`. Upstream does the same outside the editor part in **17 non-test places**, for example the chat input (`chatInputPart.ts:3737`), code blocks (`codeBlockPart.ts:340`), the SCM input (`scmInput.ts:619`), notebook cells (`notebookCellEditorPool.ts:52`) and the REPL (`repl.ts:750`) [V].
- **Model.** It comes from `ITextModelService.createModelReference(uri)`. For `file:` that resolves through `textFileService.files.resolve` (`textModelResolverService.ts:77`) [V], so it returns the **one** `TextFileEditorModel` the IDE editor also uses. Dirty state, undo (the undo service is keyed by resource) and markers are therefore shared. Nothing is copied, and no buffer is forked.
- **Lifetime.** The widget holds the reference while the file is shown. `close()` and `dispose()` release it. A model released while dirty is not disposed: the resolver waits on `canDispose` until it is clean (`textModelResolverService.ts:138-142`) [V]. So closing the side editor never loses an edit. The edit stays a dirty working copy, covered by the window-close prompt and hot exit like any other.
- **Races.** Each `open()` takes a generation number. A slower earlier open that resolves after a later one is not shown, and its reference is released (`'superseded'`). An open that finishes after dispose releases its reference too (`'disposed'`). An unreadable file gives `'unavailable'`. All three are tested (§6).
- **Focus context.** The container gets its own scoped context key, `axisSidePanelEditorFocus`. The widget is created from a child instantiation service bound to that scope, so the widget's own scope nests inside it. Every key event whose target is inside the side panel resolves with the key set. That is what the routes in §3 use.
- **Hand-off.** "Open in IDE" calls `IAxisViewService.reveal({ resource, selection })` (`services/view/browser/axisViewService.ts`), which already follows `axis.view.mode`: perWorkspace and global switch to IDE view, and split opens the file in the IDE half. The selection is passed explicitly because view state (cursor, scroll, folding) is per editor, not per model.
- **Not wired yet.** No contribution creates the editor in the product. PV-V2 places it in the Code tab and supplies the host: `ITextFileService.save`, `IAxisViewService.reveal` and `ITextResourceConfigurationService.getValue(uri, 'editor')`.

## 3. Keyboard and focus

### 3.1 Matrix

Each row was checked in the harness (§6) with real upstream keybinding resolution, unless marked otherwise.

| Key, focus in the side-panel editor | Without Axis routes (upstream) | With the prototype | Evidence |
|---|---|---|---|
| Typing, Enter, Backspace, Tab | edit the shared model | same | harness `model`, `keys` |
| `Tab` | inserts indentation; focus stays (the tab trap) | same. `Ctrl+M` (upstream "Tab moves focus") lets Tab leave | harness `keys` |
| `Escape` | consumed by find, suggest, hover, extra cursors and selection; otherwise nothing | the same widgets consume it first; when nothing does, focus returns to the file row that opened the file | harness `keys` (find widget, selection, then leave) |
| `F6` / `Shift+F6` | no editor binding claims F6 (registry scan with all contributions loaded) | Axis part cycle (`browser/axisPartNavigation.ts`): the embedded editor counts as the agent part, so F6 moves to the next part | harness `keys`; cycle by reading the overlay code [I] |
| `Mod+Enter` | **Insert Line Below** (`linesOperations.ts:692`, EditorContrib, `editorTextFocus`) | same; never an approval (§3.4) | harness `approve` |
| `Mod+S` | **saves the editor part's active editor, not this file** (`fileCommands.ts:417-457`) | saves this file through the host; does nothing in Restricted Mode | harness `route`, both ways |
| `Mod+K S` | same misroute (save without formatting) | saves this file without save participants | harness `route` |
| `Mod+Shift+S` (Save As), `Mod+\` (Split) | act on the editor part's active editor | hand off to IDE view at this file and selection | harness `route` |
| `Mod+W` / `Ctrl+F4` (Windows) | **closes the active IDE editor, which is hidden in Agent view** (`editorCommands.ts:835`) | closes the side editor and returns focus to the file row; the model survives | harness `route` |
| Quick Open, Go to Definition into another file | open in the editor part | unchanged: an explicit user open switches to IDE view (decision D-5) | by reading upstream [I] |

### 3.2 Why routes are needed (finding F2)

Upstream binds Save, Save As, Save without Formatting, Close Editor and Split Editor with `when` undefined at `WorkbenchContrib` (200), and each acts on the editor part's active editor. The only special case is Save for `EmbeddedCodeEditorWidget`. It needs a parent editor (it exists for peek views), and even then it also saves the active editor (`fileCommands.ts:445-457`) [V]. The prototype binds the same keys at weight 201 with `when: axisSidePanelEditorFocus`. Higher weight wins (`keybindingResolver.ts:381`). Without the routes, the harness shows the upstream command firing for every key in the table. With them, it never fires from the side panel and still fires from the IDE editor.

Residual: an extension that binds one of these keys at `ExternalExtension` (400) still wins inside the side panel, exactly as it does in IDE view. That is acceptable, and the same holds for Escape (a modal-editing extension keeps its Escape).

### 3.3 Escape (finding F4)

The leave command has weight −1, below `EditorCore` (0). It runs only when no editor binding matches: the find widget closes first, then a selection clears, and only then does focus leave. A mutant at weight 150 leaves the editor with the find widget still open, and it is killed.

### 3.4 The approval shortcut cannot be captured by the editor (finding F6)

`docs/design/ui/directions.md` rule 9 says an approval shortcut works only while focus is inside its card. The editor itself binds `Mod+Enter`. The prototype's gate, `approvalShortcutAllowed` in `contrib/sidePanel/common/axisSidePanelEditor.ts`, is a keydown listener **on the card**, never a keybinding-service command. It allows the key only when all of these hold:

- it is a real key press (`isTrusted`), not auto-repeat;
- the chord is exactly `Mod+Enter`;
- both the target and `document.activeElement` are inside the card;
- neither is in the composer or in any code editor.

When it allows the key, it stops propagation, so the workbench dispatcher on the window never sees the event.

Harness results:

- `Mod+Enter` in the side editor inserts a line and approves nothing. The window-level resolution is `editor.action.insertLineAfter`.
- A card appearing never takes focus from the editor.
- On the card, the key approves once, and Enter never reaches the window's bubbling phase.
- In the composer, the key approves nothing.
- A script-dispatched event is refused.
- A held key approves on the first press, and the repeat is refused.
- An editor nested inside a card never approves, with either dispatch model: the standalone dispatcher consumes the key at the editor container, and with workbench-style capture the gate refuses it.

The existing click gate (`isTrustedGesture`) is unchanged. Wiring the key gate into `approvalCards.ts` belongs to the approval UI ticket and its security review, not to this spike.

## 4. Footprint (ADR 0002 criterion 2)

| | Upstream files | Upstream lines | Method |
|---|---|---|---|
| Shell block today (patches `0010`–`0210`, excluding `product.json` and `resources/`) | 8 | +64 / −6 (32 of the added lines are markers) | `git apply --numstat` on each patch file |
| Side-panel editor (this spike) | **0** | **0** | overlay files only: `contrib/sidePanel/{common,browser,test}` |
| Budget | 12 | 300 | ADR 0002 |

`scripts/code-oss/footprint.sh` was **not** run: this host has no applied `vendor/code-oss` stamped with the current patch series. The numbers come from the same per-patch numstat that script uses. The embed cannot change them, because it adds no patch, no removal and no `replace/` file. The prototype type-checks with 0 errors against the pinned sources under upstream's strict compiler settings and TypeScript 6.0.2 (a deliberately planted error was reported, so the check is real). The upstream lint (`local/code-import-patterns`) was not run: the imports are `vs/base`, `vs/platform`, `vs/editor` and the module's own `common/`, which `LAYERS.md` allows for `contrib/*`.

## 5. Text model, dirty state and undo

- **One model.** The harness confirms both editors hold the same `ITextModel` object. Typing in the side panel shows in the IDE editor. Undo in the IDE editor undoes the side-panel edit and returns the model to its saved alternative version, and redo restores it.
- **Dirty state** belongs to the `TextFileEditorModel`, so the IDE tab, the Code tab and the window-close prompt agree. PV-V2 shows a dirty marker on the Code tab's file row, because in Agent view the IDE tab is not visible.
- **Agent writes while a buffer is dirty.** The text file service reports a save conflict, and its handler offers compare or overwrite. The compare opens in the editor part, which is an explicit switch to IDE view. This is untested here [I] and is a PV-V2 check.
- **Drift (rule 2).** A side-panel save is a user save to disk, exactly as in IDE view, so the daemon's drift detection sees it the same way. Unsaved edits are not on disk and are not drift.
- **Settings.** A raw widget does not read `editor.*` settings. The host passes the resource's `editor` configuration, and `sidePanelEditorOptions` merges it under the forced options (one level deep, so a forced `unicodeHighlight` field keeps the user's other fields). Forced:
  - read-only (and `domReadOnly`) when the repository is untrusted, with a Restricted Mode message;
  - invisible and ambiguous characters always highlighted, control characters always rendered;
  - no minimap, glyph margin, sticky scroll or drop-into-editor.

## 6. Evidence

### 6.1 Harness

`prototypes/pv-v0-editor-embed/` (README there). It runs the real upstream editor compiled at the pin, with upstream standalone services in place of the workbench ones, plus the transpiled overlay, in headless Chromium. The 43 checks in sections `model`, `route` (twice), `keys`, `approve`, `trust` and `race` all pass. `mutate.mjs` applies 15 mutants to the prototype (route and leave weights, forced-option precedence, read-only, invisible characters, four approval-gate clauses, the generation check, the three reference releases, save in read-only, focus return). All 15 are killed, by the unit tests, the harness or both, and the unmutated baseline is clean.

### 6.2 Unit tests

`contrib/sidePanel/test/common/axisSidePanelEditor.test.ts` has 9 tests (mocha, as for every overlay test). They cover option precedence and immutability, trust, the route table and its weights, the approval chord per platform, and every clause of the approval gate, including nested composer and editor nodes.

### 6.3 Not run here, carried to PV-V2

- The packaged workbench: real `TextFileEditorModel` reference counts, save conflicts, hot exit, Workspace Trust, and the extension host seeing the editor.
- The editor web worker: link detection and word-based suggestions.
- A screen reader.
- macOS (`Cmd` paths are covered only by the unit tests).
- Bindings from third-party extensions.

The tab-trap and Escape behaviour is upstream's and should match, but the A7 keyboard walkthrough must include the side panel.

## 7. Fallback: the split IDE half

Use the fallback if the PV-V2 re-check finds a blocker that cannot be fixed in the overlay, for example an extension class that breaks on editors outside the editor part, or a focus problem that needs an upstream patch.

- **Behaviour.** The Code tab keeps its file tree and Changes list but has no editor. Opening a file calls `IAxisViewService.reveal`:
  - in `split` mode this already opens the file in the IDE half without switching;
  - in `perWorkspace` and `global` modes, the Code tab opens a **transient split**: it enters split with the IDE half expanded and remembers the previous mode;
  - "Done" or Escape from the file row collapses the IDE half (`setSplitCollapsed('ide')`) and restores the mode.
- **Keyboard.** `F6` already crosses the halves (A6). The IDE half is a normal editor part, so Save, Close and Split behave as upstream and **no routes are needed**. The approval gate of §3.4 still applies.
- **Cost.** S to M, overlay only, 0 upstream files: it reuses A6's split and `reveal`, plus a "transient split" flag in the view state. What it loses: the side panel and the IDE half are separate regions, so the "quick edit without leaving the agent" feel is weaker, and screen space is shared with the IDE half.

## 8. Accessibility

- The input announces "‹file›, side panel editor". In Restricted Mode it announces "‹file›, side panel editor, read-only (Restricted Mode)", because **the EditContext input (the Chromium default) sets no `aria-readonly`**: only the textarea path sets `readonly` (`textAreaEditContext.ts:685`) [V], finding F7. This is an upstream gap that applies to IDE view too. The label is the overlay mitigation.
- Getting out: `Escape` (when nothing in the editor uses it), `Ctrl+M` then `Tab`, or `F6`. The UX copy should name all three. PV-V2 should add an in-part landmark stop so `F6` can also move between the Code tab's tree and its editor; today F6 skips whole parts.
- Focus never moves into or out of the editor by itself: a card appearing, a background update or a reveal elsewhere leaves it where it is (checked for cards).

## 9. Security notes

- **Untrusted content.** Files written by an agent are untrusted text even in a trusted repository. The editor renders text, never HTML. The forced options always show bidi controls, zero-width and confusable characters (checked with an RLO and zero-width fixture). Ctrl+click on a link goes through `IOpenerService`, so the `openExternal` allow-list and full-URL link protection (patches `2030`, `2050`) apply. Hovers render extension markdown under the same rules as IDE view.
- **Workspace trust (ADR 0004 decision 12).** The caller passes `trusted`, derived at each open from the same source that decides IDE view (policies §2). Untrusted means read-only (typing ignored, Save refused, checked in the harness). Restricted Mode in the window still governs extensions and tasks as usual. A trust change while a file is open must reopen it with the new value; this is a PV-V2 test.
- **Extension host exposure.** With `isSimpleWidget: false`, the editor is a `TextEditor` in the extension host and becomes `activeTextEditor` when focused (`mainThreadDocumentsAndEditors.ts:203-221`) [V]. That grants no new capability: the document is already synchronized, and any extension can already edit it through a workspace edit. But commands of the form "act on the active editor" will act on the side panel while it has focus, which matches what the user sees. The alternative, `isSimpleWidget: true`, hides the editor from extensions but not the document, and makes Axis's editor behave unlike every other file editor. **Recommended: false**, recorded here for the design review.
- **Approvals.** §3.4. The editor can never produce an approval, by key or by click: a click needs the card's own button (unchanged gate).
- **Composer runs.** Side-panel edits are user edits (rule 2). They never go through the broker or the staging scanner, the same as IDE view.

## 10. Findings index

| Id | Finding | Where handled |
|---|---|---|
| F1 | Shared model, undo and dirty state work with no copying | §2, §5 |
| F2 | Save, Save without Formatting, Save As, Close and Split act on the hidden IDE editor | routes, §3.2 |
| F3 | A raw widget ignores `editor.*` settings | option merge, §5 |
| F4 | Escape is free only when no editor widget wants it | leave weight −1, §3.3 |
| F5 | Tab is trapped (upstream); F6 is unclaimed by the editor | UX copy, §8 |
| F6 | The editor binds `Mod+Enter`; an approval key must be card-scoped | gate, §3.4 |
| F7 | No `aria-readonly` with EditContext | label, §8 |
| F8 | Non-simple widget is extension-visible as the active editor | decision for review, §9 |
