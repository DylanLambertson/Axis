# PV-V0 spike: an embedded editor in the side panel

- **Status:** Spike report for ticket PV-V0 (`product-vision-v2-tickets.md`), revised after design review 1. It feeds PV-V2 and the side-panel editor section that `axis-agent-shell.md` gains after this spike.
- **Date:** 2026-11-20. Upstream baseline: Code OSS `1.144.0`, commit `2c33b50`. Upstream paths are relative to `src/vs/` at that commit; `file:line` refers to it.
- **Question (product-vision-v2 §3.5 rule 1, §4):** can a real Code OSS editor widget live in an Axis part outside the editor part, share the IDE view's text model, route focus correctly, and stay within the ADR 0002 criterion 2 budget (at most 12 upstream files and 300 lines)? If not, Axis uses the split-half fallback.

## 1. Recommendation

**Embed.** The widget, the shared model and every keyboard rule below work with no upstream change. The shell block stays at **8 upstream files** (§4), and the prototype is overlay-only. The safety rules are not optional, though. Without them, Save in the side panel saves a different file and Close closes an IDE editor hidden behind Agent view. 69 default-key commands at the pin read the editor part's active editor (§3.2).

PV-V2 builds on the prototype under these conditions:

1. **Command guards.** The command guards and the Escape rule of §3 ship with the editor. The key scan (`scan-keys.mjs --check`) is re-run on every upstream sync and fails on any flagged command the policy does not classify.
2. **Approval shortcut.** When it is built, it uses the card-scoped DOM gate of §3.4 **and then** the same `AxisApprovalController` answer path as a click: shown digest, guard time, expiry, in flight. It is never a keybinding-service command. The DOM gate alone is not sufficient.
3. **Settings.** The editor reads the user's `editor.*` settings, then forces the options of §5.
4. **Conflict policy.** When a dirty side-panel buffer meets a write by a run, the policy in §5.2 applies.
5. **Go/no-go list.** The list in §8 passes in the packaged workbench before PV-V2 is reviewed. Any item that fails and cannot be fixed in the overlay switches PV-V2 to the fallback (§7). The fallback reuses existing mechanisms and also changes 0 upstream files.

## 2. How the embed works

`AxisSidePanelEditor` (`code-oss/overlay/src/vs/axis/contrib/sidePanel/browser/axisSidePanelEditor.ts`):

- **Widget.** It creates a `CodeEditorWidget` through `instantiationService.createInstance`, with all registered editor contributions (`EditorExtensionsRegistry.getEditorContributions()`) and `isSimpleWidget: false`. Upstream does the same outside the editor part in **17 non-test places**, for example the chat input (`chatInputPart.ts:3737`), code blocks (`codeBlockPart.ts:340`), the SCM input (`scmInput.ts:619`), notebook cells (`notebookCellEditorPool.ts:52`) and the REPL (`repl.ts:750`) [V].
- **Model.** It comes from `ITextModelService.createModelReference(uri)`. For `file:` URIs this resolves through `textFileService.files.resolve` (`textModelResolverService.ts:77`) [V]. In the workbench that is the **one** `TextFileEditorModel` the IDE editor also uses. Dirty state, undo (the undo service is keyed by resource) and markers are therefore shared. Nothing is copied, and no buffer is forked. This sharing is established by reading the source; the harness shows sharing only for the standalone resolver (§6).
- **Lifetime.** The widget holds the reference while the file is shown, and `close()` and `dispose()` release it. A model released while dirty is not disposed: the resolver waits on `canDispose` until it is clean (`textModelResolverService.ts:138-142`) [V]. Closing the side editor therefore never loses an edit. The edit stays a dirty working copy, which the window-close prompt and hot exit cover.
- **Races.** Each `open()` and `close()` advances a generation counter:
  - an open overtaken by a later open or by `close()` is not shown, and its reference is released (`'superseded'`);
  - an open that finishes after dispose, or fails after dispose, returns `'disposed'`;
  - an unreadable file returns `'unavailable'`.

  All of these are tested (§6).
- **Reopen.** Opening a file in a widget that already exists re-applies all options, including read-only from the new file's trust, before setting the model. A trusted-to-untrusted reopen is tested in both directions.
- **Focus context.** The container gets its own scoped context key, `axisSidePanelEditorFocus`. The widget is created from a child instantiation service bound to that scope, so every key event inside the side panel resolves with the key set. Escape uses it (§3.3).
  - *Constraint (review N5):* PV-V2 must not set `overflowWidgetsDomNode` or `fixedOverflowWidgets`. A focused overflow widget outside the container would leave that scope.
- **Hand-off.** "Open in IDE" calls `IAxisViewService.reveal({ resource, selection })`, which already follows `axis.view.mode`. The selection is passed explicitly because view state is per editor.
- **Not wired yet.** No contribution creates the editor in the product. PV-V2 supplies the host:
  - `ITextFileService.save` and `isDirty`;
  - `IAxisViewService.reveal`;
  - `ITextResourceConfigurationService.getValue(uri, 'editor')`;
  - a status message for blocked commands;
  - the focus-change auto-save (§3.2).

  PV-V2 also calls `registerAxisSidePanelEditorCommands()` once every upstream contribution has registered (its `missing` list must be empty).

## 3. Keyboard, commands and focus

### 3.1 Matrix

Each row was checked in the harness (§6) unless marked otherwise. Key resolution there is the real upstream `KeybindingResolver` and `KeybindingsRegistry`, with the standalone dispatcher. The workbench commands are stand-ins registered with the pin's keys, weight and `when`; the standalone dispatcher listens on the editor container rather than on the window, and §3.4 covers both dispatch models. Windows chord variants are covered by the guard design (§3.2), not by the harness, which runs on Linux.

| Key or command, focus in the side-panel editor | Upstream | With the prototype | Evidence |
|---|---|---|---|
| Typing, Enter, Backspace | edit the shared model | same | `model` |
| `Tab` | inserts indentation; focus stays (the tab trap) | same. `Ctrl+M` (upstream "Tab moves focus") lets Tab leave | `keys` |
| `Escape` | consumed by find, suggest, hover, extra cursors and selection; otherwise nothing | the same widgets consume it first; when none does, focus returns to the file row | `keys` |
| `F6` / `Shift+F6` | no editor binding claims F6 | the Axis part cycle (`axis.action.focusNextPart`): the embedded editor counts as the agent part | `keys`; cycle by reading [I] |
| `Mod+Enter` | **Insert Line Below** (`linesOperations.ts:692`) | same; never an approval (§3.4) | `approve` |
| `Mod+S`, `Mod+K S` | **save the editor part's active editor** (`fileCommands.ts:417-457`) | save this file; nothing in Restricted Mode | `route`, both ways |
| `Mod+Shift+S`, `Mod+\`, `Mod+K P`, Compare, Change Language Mode, Test at Cursor … | act on the hidden IDE editor | hand off to IDE view at this file and selection | `route` (Save As, Split, Copy Path) |
| `Mod+W` | **closes the hidden IDE editor** (`editorCommands.ts:835`) | closes the side editor; the model survives | `route` |
| `Ctrl+PageDown`, `Mod+K W`, `Alt+1`…`9`, group focus and move … | act on the hidden IDE group | blocked, with a status message | `route` (Next Editor, Close Group) |
| Save All (menu; `Cmd+Alt+S` on macOS) | saves editors in groups only; **skips a side-panel-only dirty file** (`fileCommands.ts:463-474`) | original, then every dirty side-panel file | `route` |
| A command given an explicit target (tab or Explorer menu) | acts on that target | unchanged | `route` |
| Leaving the editor with `files.autoSave: onFocusChange` | not saved: auto-save follows the editor part's pane only (`editorAutoSave.ts:120-160`) | blur reported to the host, which saves under that mode | `route` (blur reported) |
| Quick Open, Go to Definition into another file | open in the editor part | unchanged: an explicit user open switches to IDE view (D-5) | by reading [I] |

### 3.2 The inventory, and why commands are guarded rather than keys (finding F2, review S1)

Upstream binds many commands with `when` undefined (or a `when` that holds in any text editor). These commands read `editorService.activeEditor`, `activeEditorPane`, `activeTextEditorControl` or the active group, and in Agent view all of those belong to the hidden IDE editor.

**Inventory.** `prototypes/pv-v0-editor-embed/scan-keys.mjs` measures the inventory at the pin:

1. It registers every workbench contribution: the web workbench main is imported, never started.
2. It keeps each default keybinding that can fire with focus in the side-panel editor (its `when` evaluated against that context, with an IDE editor open but hidden) and whose command is not an editor command.
3. It runs each handler against recording services.

Result: **970 default keybindings, 132 candidates, 61 that read the active editor and 10 that delegate**. The recording services stop a handler that loops on them after 500 reads, and a handler that never returns would be recorded as `hung` and the scan continued in a fresh page; none was. The rows are in `scan-2c33b50.tsv`: 71 rows, 69 distinct commands.

**Classification.** `AXIS_SIDE_PANEL_COMMAND_POLICY` (`contrib/sidePanel/common/axisSidePanelEditor.ts`) classifies each command:

| Action | Commands |
|---|---|
| `save`, `saveWithoutFormatting` | Save, Save without Formatting |
| `close` | Close Editor |
| `saveAllToo` | Save All (no Linux key; menus and macOS) |
| `openInIde` | Save As, Revert File, Change Language Mode, Compare with Saved or Clipboard, the three copy-path commands, the six Split commands, Copy Editor to New Window, next/previous comment thread, inline breakpoint, and the six testing at-cursor / current-file commands |
| `block` | the tab, group and editor-index commands: Close Group, Close Saved, Keep, Pin, Next/Previous Editor (in group), Last Editor, Open Editor at Index 1–9, focus and move group, move editor, toggle group layout |
| `accept` | Undo, Redo, Select All (they read the *focused* code editor first, which is the side-panel editor); the upstream F6 commands (Axis replaces them); Toggle Breadcrumbs, Open Folder, Find in Files, Select Theme |

**Guards.** `registerAxisSidePanelEditorCommands()` re-registers every non-`accept` command under its own id. The latest registration wins (`commands.ts:109`), and disposing it restores the original. The guard runs the policy action when the focused code editor is a side-panel editor and the command got no explicit arguments; otherwise it runs the original. Guarding the **command** instead of its keys covers, by construction:

- every key and chord;
- the macOS and Windows keymaps (`Ctrl+F4`, `Cmd+Alt+S`);
- user `keybindings.json` entries;
- built-in-extension (300) and external-extension (400) rebindings of the same command;
- menus.

The harness runs each guarded key both ways: without the guards the upstream command fires, and with them it never fires from the side panel and still fires from the IDE editor.

**Residuals.**

- **New upstream commands.** A command added by a later upstream release is unguarded until classified. `scan-keys.mjs --check` fails on it; a removed policy entry was tested to make the check fail.
- **Extension commands.** An extension's own command that reads `activeTextEditor` sees the side-panel editor, which is correct (§9).
- **Command palette.** When a command runs from the palette, the palette has focus, so the original runs on the IDE editor. PV-V2 decides whether the guard should also use "last focused editor was the side panel and Agent view is shown". It is on the go/no-go list.
- **Peek inside the side editor.** A peek or embedded editor inside the side editor is not a side-panel editor, so a guarded Save from there runs the original, as upstream does (review N6). This is on the list.
- **Status bar.** The editor status bar (Ln/Col, language, EOL, encoding) follows the editor part's active editor. In Agent view it describes the hidden editor. PV-V2 hides those entries in Agent view or binds them to the side editor; it is on the list.

### 3.3 Escape (finding F4)

The leave command has weight −1, below `EditorCore` (0), so it runs only when no editor binding matches: the find widget closes first, then a selection clears, and only then does focus leave. A mutant at weight 150 is killed.

The weight cannot override user `keybindings.json` or an extension's Escape (a modal-editing extension keeps it). That is intended. The other ways out still work: `Ctrl+M` then Tab, and F6.

### 3.4 The approval shortcut (finding F6, review S3)

The editor binds `Mod+Enter`. `docs/design/ui/directions.md` rule 9 says an approval shortcut works only while focus is inside its card.

**DOM gate.** The prototype's gate, `approvalShortcutAllowed`, is a keydown listener **on the card**, never a keybinding-service command. It allows the key only when:

- it is a real press (`isTrusted`), with no auto-repeat and no IME composition;
- the chord is exactly `Mod+Enter`;
- both the target and the active element are inside the card;
- neither is in the composer or in any code editor.

On allow it stops propagation, so the workbench dispatcher (a bubbling-phase window listener, `keybindingService.ts:278`) never sees the event.

Harness results:

- `Mod+Enter` in the side editor inserts a line and approves nothing.
- A card that appears never takes the focus.
- On the card, the key approves once, and Enter never bubbles to the window.
- The composer, a script-dispatched event and a held key are refused.
- An editor nested in a card never approves, under either dispatch model.

**The DOM gate is not sufficient on its own.** The click path also goes through the controller (`axisApprovals.ts:210-232`), which checks the digest the card shows, the guard time, expiry, and whether an answer is in flight or already settled. A key that passes the DOM gate must go through **the same controller path**, with these rules:

- **Digest.** It must be the digest the card *shows*, so a card re-rendered under a held finger is stale and refused.
- **Guard time.** It counts from whichever is later: the card's last change or the moment focus entered the card.
- **Gesture check.** `isTrustedGesture` requires a click on the button, so the key path needs its own trusted-key check in the controller. That check is this gate's clauses re-verified there against the card's challenge id.
- **Scope builder.** It must walk `event.composedPath()` for the composer and editor checks, because `closest()` stops at a shadow root.
- **Where it lives.** The scope functions belong in tested overlay code, not in the view.

All of this belongs to the approval UI ticket and its security review. This spike does not wire the key gate, and the click gate is unchanged.

## 4. Footprint (ADR 0002 criterion 2)

| | Upstream files | Upstream lines | Method |
|---|---|---|---|
| Shell block today (patches `0010`–`0210`, excluding `product.json` and `resources/`) | 8 | +64 / −6 (32 of the added lines are markers) | `git apply --numstat` on each patch file; reproduced by the reviewer |
| Side-panel editor (this spike) | **0** | **0** | overlay files only: `contrib/sidePanel/{common,browser,test}` |
| Budget | 12 | 300 | ADR 0002 |

`scripts/code-oss/footprint.sh` was **not** run, because this host has no applied `vendor/code-oss` stamped with the current patch series. The numbers come from the per-patch numstat that the script itself uses. The embed cannot change them: it adds no patch, removal or `replace/` file. Command guards re-register commands at runtime and touch no upstream source.

The prototype type-checks with 0 errors against the pinned sources under upstream's strict compiler settings, using TypeScript 6.0.2 from a checkout at the pin. A deliberately planted error is reported. The upstream lint (`local/code-import-patterns`) was not run. The imports are `vs/base`, `vs/platform`, `vs/editor`, the module's own `common/`, and `vs/axis/services/workspaces/common` for `cleanDisplayText`, all of which `LAYERS.md` allows for `contrib/*`.

## 5. Text model, dirty state and undo

### 5.1 Shared model

- **Shown in the harness, standalone resolver:** both editors hold the same `ITextModel`. Typing in the side panel shows in the IDE editor. Undo in the IDE editor undoes the side-panel edit and returns to the saved version, and redo restores it.
- **Established by reading (§2):** in the workbench the model is the shared `TextFileEditorModel`, so dirty state, save, revert and the window-close prompt agree.
- **Dirty marker.** PV-V2 shows one on the Code tab's file row, because the IDE tab is not visible in Agent view.
- **Settings.** A raw widget does not read `editor.*`. The host passes the resource's `editor` configuration, and `sidePanelEditorOptions` merges it under the forced options, one level deep. The forced options are:
  - read-only (and `domReadOnly`) when the repository is untrusted, with a Restricted Mode message;
  - invisible and ambiguous characters always highlighted, and control characters always rendered;
  - no minimap, glyph margin, sticky scroll or drop-into-editor;
  - a spoken label cleaned with `cleanDisplayText` and clamped to 120 code points, so a file name with bidi or zero-width characters cannot spoof what is read out (review N4).
- **Auto-save.** `afterDelay` is per working copy and follows the model whichever editor shows it [I]. `onFocusChange` follows only the editor part's pane, so the side editor reports its blur to the host, which saves under that mode (harness: blur reported).

### 5.2 A write by a run to a file whose buffer is dirty (review S2)

The pinned behaviour, by reading:

- The text file model sees the disk change.
- If the buffer is **clean**, the model reloads through `modelService.updateModel`, which pushes undo stops (`modelService.ts:365-385`). The reload is therefore undoable: **shown in the harness**, Ctrl+Z in the side editor reverts the reload into a dirty buffer.
- If the buffer is **dirty**, it keeps the user's text. The run's write stays on disk, invisible in the editor until a save meets the conflict, which offers Compare or Overwrite.

**Policy for PV-V2:**

1. **Notice.** While a side-panel buffer is dirty and its file changes on disk, the file row and the editor show "Changed on disk" with **Compare** (opens the diff in IDE view, an explicit switch) and **Discard my changes** (reverts to disk).
2. **Overwrite.** Saving over it is allowed. It is a user write, and for a composer run it produces the drift notice through the compare-and-swap path (`axis-agent-shell-policies.md` §3.3 to §3.5), exactly as an IDE save would.
3. **Undo across a reload.** It is a user edit. It is accepted and documented: the buffer turns dirty, and saving it is a user write that drift tracking sees.
4. **Auto-save.** It never overwrites a conflict. Upstream auto-save does not resolve save conflicts [I]; this is verified on the §8 list.
5. **Runs are never blocked by the editor.** A dirty buffer does not refuse a composer or CLI write. Refusing would let the user's open editor block agents, and drift detection already covers that case.

Items 1, 2 and 4 are on the go/no-go list as packaged-workbench tests.

## 6. Evidence

`prototypes/pv-v0-editor-embed/` (README there) runs the real upstream editor compiled at the pin, with upstream standalone services in place of the workbench ones, plus the transpiled overlay, in headless Chromium.

- **Browser checks:** `run.mjs` has **47 checks** in sections `model`, `route` (twice), `keys`, `approve`, `trust` and `race`, and all pass. `check()` compares the observed value with the expected one and prints both.
- **Mutation run:** `mutate.mjs` applies **27 mutants** to the prototype. They include the reviewer's three survivors (reopen keeps the model, reopen keeps the options, close does not cancel an open), the guard's focus and argument rules, the policy classes, Save All, the blur report, the label cleaning, five approval-gate clauses, the races and reference releases, read-only save and focus return. **All 27 are killed** by the unit tests, the browser checks or both, and the unmutated baseline is clean.
- **Key scan:** `scan-keys.mjs` produces the S1 inventory (§3.2).
- **Unit tests:** `contrib/sidePanel/test/common/axisSidePanelEditor.test.ts` has 12 tests (mocha, as for every overlay test). They cover option precedence and immutability, trust, label cleaning, the command policy, the scan gate, the guard decision, the approval chord per platform, and every clause of the approval gate.

## 7. Fallback: the split IDE half

Use the fallback if a §8 item fails and cannot be fixed in the overlay.

- **Behaviour.** The Code tab keeps its file tree and Changes list but has no editor. Opening a file calls `IAxisViewService.reveal`:
  - in `split` mode this already opens the file in the IDE half without switching;
  - in `perWorkspace` and `global` modes, the Code tab opens a **transient split**: it enters split with the IDE half expanded and remembers the previous mode;
  - "Done", or Escape from the file row, collapses the IDE half (`setSplitCollapsed('ide')`) and restores the mode.
- **Keyboard.** `F6` already crosses the halves (A6). The IDE half is a normal editor part, so every upstream command acts on the right editor, and **no guards are needed**. The approval rules of §3.4 still apply.
- **Cost.** S to M, overlay only, 0 upstream files: it reuses A6's split and `reveal`, plus a transient-split flag in the view state.
- **What it loses.** Quick edits no longer happen next to the agent, and the IDE half takes screen space.

## 8. Go/no-go list for PV-V2 (packaged workbench)

Each item must pass before PV-V2 is reviewed. "Fallback" means: if it fails and cannot be fixed in the overlay, build §7 instead.

| # | Check | If it fails |
|---|---|---|
| 1 | The browser checks of §6, re-run against the real workbench services (`TextFileEditorModel`, the workbench keybinding service on the window) | fallback |
| 2 | Reference counts: closing the side editor with a dirty buffer keeps the working copy, and the window-close prompt and hot exit cover it | fallback |
| 3 | `scan-keys.mjs --check` passes on the shipped pin; `missing` is empty at registration; every guarded id resolves to the guard at runtime | fix the policy |
| 4 | The §5.2 conflict policy: notice, Compare, Discard, overwrite producing the drift notice, auto-save never overwriting a conflict | fix in overlay; else fallback |
| 5 | The command palette and menus invoking a guarded command with the side editor last focused (§3.2 residual) | fix in overlay |
| 6 | Status-bar entries in Agent view | fix in overlay |
| 7 | Extension host: the side editor is `activeTextEditor` when focused, and extensions acting on it behave (§9) | fallback if an extension class breaks |
| 8 | Editor web worker: link detection (Ctrl+click through the opener and link protection) and word-based suggestions | fix in overlay |
| 9 | Screen reader walkthrough (NVDA or VoiceOver): label, read-only announcement, the ways out | fix in overlay |
| 10 | macOS keymap (`Cmd` paths, `Cmd+Alt+S`) and Windows (`Ctrl+F4`) | fix in overlay |
| 11 | Trust change while a file is open reopens it with the new value | fix in overlay |
| 12 | A peek editor inside the side editor (§3.2 residual) | accept or fix |
| 13 | No `overflowWidgetsDomNode` or `fixedOverflowWidgets` (§2 constraint) | fix in overlay |

## 9. Accessibility and security

- **Labels.** The input announces "‹file›, side panel editor". In Restricted Mode it adds "read-only (Restricted Mode)", because **the EditContext input (the Chromium default) sets no `aria-readonly`**; only the textarea path sets `readonly` (`textAreaEditContext.ts:683-686`) [V], finding F7. That is an upstream gap that affects IDE view too.
- **Getting out.** The ways out are `Escape` (when nothing in the editor uses it), `Ctrl+M` then `Tab`, and `F6`. PV-V2 adds an in-part landmark stop so that `F6` can also move between the Code tab's tree and its editor. Focus never moves into or out of the editor by itself.
- **Untrusted content.** Files a run writes are untrusted text even in a trusted repository. The forced options always show bidi controls, zero-width and confusable characters (tested). Ctrl+click on a link goes through `IOpenerService`, so the `openExternal` allow-list and full-URL link protection (patches `2030`, `2050`) apply (§8 item 8). Hovers render extension markdown under the same rules as IDE view.
- **Workspace trust (ADR 0004 decision 12).** The caller passes `trusted`, derived at each open from the same source that decides IDE view (policies §2). Untrusted means read-only: typing is ignored and Save is refused, including after a reopen in the same widget (tested).
- **Extension host exposure (F8).** With `isSimpleWidget: false`, the editor is a `TextEditor` in the extension host and becomes `activeTextEditor` when focused (`mainThreadDocumentsAndEditors.ts:205-221`) [V]. That grants no new capability: the document is already synchronized and editable through a workspace edit. **Recommended: false.** The reviewer agrees, and the owner records the decision.
- **Approvals.** The editor can never produce an approval, by key or click (§3.4).
- **Runs.** Side-panel edits are user edits (rule 2). They never go through the broker or the staging scanner.

## 10. Findings and owner decisions

| Id | Finding | Where handled |
|---|---|---|
| F1 | Shared model, undo and dirty state work with no copying | §2, §5.1 |
| F2 | 69 default-key commands read the hidden IDE editor (save, close, tabs, groups, copy path, compare, Save All …) | command guards and policy, §3.2 |
| F3 | A raw widget ignores `editor.*` settings, and `onFocusChange` auto-save ignores it | option merge and blur report, §5.1 |
| F4 | Escape is free only when no editor widget wants it | leave weight −1, §3.3 |
| F5 | Tab is trapped (upstream); F6 is unclaimed by the editor | §9 |
| F6 | The editor binds `Mod+Enter`; an approval key needs the card-scoped gate plus the controller | §3.4 |
| F7 | No `aria-readonly` with EditContext | label, §9 |
| F8 | Non-simple widget is extension-visible as the active editor | owner decision |
| F9 | A reload from disk is undoable into a dirty buffer, and a dirty buffer hides a run's write | policy, §5.2 |

Owner decisions to record:

1. **F8:** `isSimpleWidget: false`.
2. **Read-only side panel in an untrusted repository.** The side panel is read-only there while IDE view may edit the same model, which follows rule 5 but makes the two surfaces disagree.
3. **Save All and `onFocusChange`.** Both cover side-panel-only dirty files (§3.2, §5.1).
4. **Conflicts.** The conflict policy of §5.2.
