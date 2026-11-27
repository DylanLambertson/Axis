# The plugin grant contract (ticket PV-K2, grant part)

- **Status:** design only, not built. Date 2026-11-26; revised 2026-11-27 after review 1 and the decisions of
  2026-11-26 (owner delegation, reversible).
- **Scope:** who may write `plugin_enablement` and `plugin_grants` (journal v16, PV-K1b), through which calls, what each write is
  bound to, and what a revoke or a disable ends.
- **Not in scope:** install, update, signatures and extraction are the rest of PV-K2 and follow ADR 0008 decisions 7 and 8. They
  create the plugin's row and propose grants; they grant only through the calls below (section 1, condition 4).
- **Sources:** ADR 0008 decisions 4, 6 and 8 and the amendment "how the main-built dialog is reached"; `plugin-grants.md`;
  `plugin-run-start.md` section 3.1; `threat-model-phase4a.md` OI-3 and gate 4a/L24 (partly superseded, section 4).

## 1. Must not enable

PV-K2's grant calls must not be enabled, and no PR that makes `runs.start` grantable may merge, until **all six** of these hold.
This list is the gate; the PV-K2 ticket row points here.

1. **The card.** The own shell's approval card reads `axis.approvals/1.pending` and `axis.approvals/1.detail`, and shows the whole
   escaped prompt and the project, workspace, mode, provider and model of a plugin's run start.
2. **Every supported listing reader.** The Code OSS shell is retired, or every supported pending-approvals reader accepts the
   optional `requester` and reads `detail` safely. Today the Code OSS overlay's `axisDaemonReplies.ts` `readPendingChallenges`
   accepts only its fixed eight fields, so one plugin challenge makes it reject that window's whole listing.
3. **A real-host test.** A test through the real host composition covers an attested plugin request, then the host window's
   pending list, detail and card, then the user's resolve, the plugin's spend and the attributed, tainted run, with the refusals
   on the way. It covers PV-K1e-b's two wiring lines (`compose.ts` `plugins:`, `compose-serving.ts` `pluginStarts:`).
4. **Every grant path.** A source pin or a test shows that every production path that grants `runs.start` goes through the tier-4
   native flow of section 3: install, update, and any other writer of `plugin_grants`.
5. **The tier.** PV-K1e-T4 (whether a plugin's run start is itself tier 4) is decided. If it is, the plugin tier ceiling
   (`PLUGIN_MAX_TIER`, 3) and `PluginChallenges.prepare`'s refusal at tier 4 and above are redesigned and tested first.
6. **The connection is still there.** A plugin's run start checks that the plugin's connection, and so its host window, is still
   open after the spend and right before the run is recorded. Today a start whose host window closes after the spend still goes
   ahead (review 2 of PV-K1e-b; a user's own start behaves the same). A test closes the host window at each step after the spend
   and asserts that nothing is created.

## 2. The calls

A new contract, `axis.plugins/1`. Every method is user-only:
- a `userRule` row;
- never a web client (outside `WEB_ALLOWED`);
- never a plugin (`axis.plugins/` is added to `PLUGIN_DENY_CONTRACTS`);
- never a worker;
- and the handler refuses every actor but the user with `E_NOT_FOUND`.

| Method | What it does | Tier |
|---|---|---|
| `list` | the plugins of one project, each with its switch, generation and granted permissions | 0 |
| `grant` | adds one permission of the closed set to a plugin in a project | **4**: a daemon challenge plus `native.confirm`, in a dialog main draws |
| `enable` | turns a plugin on in a project | **4**, as `grant` |
| `revoke` | removes one permission | 2 |
| `disable` | turns a plugin off in a project | 2 |

- **One confirmation per grant** (decision 1). The install dialog asks for each permission as its own tier-4 confirmation; there is
  no batch.
- **Why revoke and disable are tier 2.** A decrease applies at once (ADR 0008 decision 8). The accepted availability risk: any code
  in a renderer of the user's window can revoke a grant or disable a plugin, and so withdraw that plugin's open approvals. Recovery
  takes a tier-4 re-grant or enable, which the renderer cannot do alone. `endPlugin` (section 4) withdraws only that plugin's
  challenges in that project, never another plugin's and never one of the user's own.

## 3. What a grant or an enable binds

- **The digest is a versioned tuple with a fixed shape**, so no two different states share a preimage (a hyphen-joined string
  would: `("a-b", "c")` and `("a", "b-c")`). It is JSON of `["axis.plugin-grant/1", method, pluginId, projectId, permission or
  null, generation, enabled, permissions]`:
  - every member's type is checked before encoding;
  - `permissions` is the plugin's whole current set, sorted;
  - the same full state is bound for `grant` and for `enable`.

  A revoke, a disable, another grant or an enable between the dialog and the confirmation changes the digest, and the confirmation
  is refused (`E_CONFLICT`, "the content changed").
- **The lock.** The content hook takes the project mutex only for the snapshot at issue, and releases it before the user answers.
  At the spend it takes the mutex again and holds it across:
  1. a fresh snapshot;
  2. the digest comparison;
  3. the spend;
  4. the audit hand-off;
  5. the write.

  Every competing writer of the plugin rows (the other calls here, install and update) takes the same mutex.
- **The write** is the built `journal.plugins.grant` or `setEnabled`. A permission already granted gives `E_CONFLICT` with reason
  `already_granted`, and nothing is written. The generation moves only on a real revoke, or an enabled-to-disabled change (the v16
  trigger; a no-op `disable` or a `revoke` of a missing grant leaves it unchanged, tested).

### 3.1 The native dialog line

Main's dialog shows one line, built only from values the daemon derives, never from the manifest. `nativeSummary` replaces a
detail that holds a control, format (bidi, zero-width), surrogate or separator character, and cuts the detail at 80 UTF-16 units
in the middle. A stored plugin id can be 64 characters, which would make a naive line 139 units, and the cut would lose the
project and the permission's wording. So the line follows the task Start pattern (`tasks/confirm.ts`):

- Every part is sanitised first: unsafe characters become `?`, and runs of space collapse.
- The whole line is budgeted before `nativeSummary`, so it is never cut or replaced.
- The parts, in order:
  1. **The mandatory wording**, never dropped. When the grant makes a dangerous combination, a fixed marker of at most 16 units
     ("SENDS DATA OUT: "). Then the permission's fixed short wording, at most 28 units (for `runs.start`: "may ask to start AI
     runs").
  2. **The plugin**, in a stable id form of at most 19 units: the id when it fits, else its first 12 characters, "…" and the first
     6 hex digits of the SHA-256 of the whole id. The card shows the whole id and the same short form, so the user can match them.
  3. **The project's display name**, which the user chose, in whatever units remain (at least 8).
- **Overflow** cannot drop the mandatory wording. If the fixed parts ever left no room for the project, the grant is refused at
  issue with a closed reason, never shown cut.
- **The digest binds the full identities**: the whole plugin id and the project id, never the short forms.
- **Tests** build the line for the longest plugin id and project name, and for each unsafe class. They assert on the final
  `native.confirm` summary main receives, never on an intermediate string, and that no manifest text appears ("SAFE TO APPROVE"
  as a manifest name never does).

## 4. Revoke and disable

- **The generation grows by one** on every real revoke and every enabled-to-disabled change, and at no other time.
- **Open challenges end at once.** After the write, the handler calls `approvals.endPlugin(pluginId, projectId)`. It withdraws
  every open challenge of that plugin in that project, as its requester (the a2-1b binding path), and nothing else. Without it the
  challenges would be refused only when the next call or detail read touched them.
- **An approval already given cannot be spent.** The binding's `valid()`, the content digest and the generation the handler
  carries (PV-K1e-b, `ApprovedPluginStart`) all hold the approved generation.
- **Live runs keep running** (decision 2). A disable, a revoke or an uninstall does not cancel the runs a plugin started: the user
  approved each one, it is tainted, every side effect asks again, and the run stays attributed to the plugin and the user can
  cancel it.
  - This **supersedes** `threat-model-phase4a.md` OI-3 and gate 4a/L24 for plugin grant and enablement changes only.
  - A project's trust being withdrawn (untrust, or the host's trust revoke) is distinct: it still cancels every run in the project
    (4a/L18).
- **The plugin's view stays open.** The policy refuses each later call; closing the view is the shell's choice.
- **A disable keeps the grants.** Enabling again is a tier-4 `enable`, never a new `grant`.

## 5. Limits, audit and the texts this changes

- **Limits:** at most 64 plugins per project (v16) and at most 8 permissions per plugin (the closed set; the journal's CHECK
  refuses any other).
- **Audit:** every write appends `journal.plugin.record` (ids, a fixed field and the permission). The tier-4 calls are also audited
  by the challenge manager.
- **Texts this supersedes:** `plugin-grants.md` section 2, and the comments of `plugin-grant-store.ts` and `schema-plugins.ts`,
  said every method must be tier 4 or main-owned. They now point here: tier 4 for `grant` and `enable`, tier 2 for `revoke` and
  `disable`.

## 6. Tests and mutants for the ticket

**Tests:**
- every method refused for a plugin, a web client and a worker;
- `grant` and `enable` run only after the native confirmation;
- the dialog line, as in section 3.1;
- a concurrent revoke, disable, grant or enable between the dialog and the confirmation refuses it;
- digest preimages that differ only in where a separator falls do not collide;
- `already_granted`;
- a no-op disable and the revoke of a missing grant leave the generation unchanged;
- revoke and disable end only that plugin's open challenges at once, and never a user challenge;
- a run started before the revoke keeps running;
- disable then enable keeps the grants and the hourly count (v17).

**Mutants:**
- `grant` or `enable` at tier 3;
- manifest text in the line;
- a hyphen-joined digest;
- the generation, or the permission set, left out of the digest;
- the mutex not held at the spend;
- `endPlugin` not called, or ending other challenges;
- revoke allowed to a plugin;
- `axis.plugins/` missing from the deny list.

## 7. Decisions (2026-11-26, owner delegation, reversible)

1. **At install,** each grant is its own tier-4 confirmation; there is no batch.
2. **A disable does not cancel live runs.** The plugin's open challenges are withdrawn at once (section 4).
3. **PV-K1e-T4 is deferred** to the moment PV-K2 is about to be enabled, as condition 5 of section 1. The leaning for then: keep
   tier 3 while every side effect asks and the run is tainted, and revisit with real plugin usage.

## 8. Implementation plan

Five slices, each its own PR with a security-critical review. The first four can merge while the grant calls stay switched off;
the fifth switches them on, and only once all six conditions of section 1 hold. Today nothing in production writes a grant: only
tests call `journal.plugins.grant` and `setEnabled`.

### 8.1 Slices

| Slice | What | Depends on | Size |
|---|---|---|---|
| **K2-g1** | `axis.plugins/1` in the protocol with `list`, `revoke` and `disable` handlers; the policy rows (user only; outside `WEB_ALLOWED`; `axis.plugins/` added to `PLUGIN_DENY_CONTRACTS`); `approvals.endPlugin(pluginId, projectId)`. | PV-K1e-b (merged) | M |
| **K2-g2** | `grant` and `enable` at tier 4: the content hook (the versioned tuple digest, the project mutex at the spend), the native line builder of section 3.1, and `already_granted`. Registered but switched off: the handler refuses with `E_UNAVAILABLE` unless the host option `pluginGrants` is on, and it is off in production. | K2-g1 | M-L |
| **K2-g3** | **Condition 4, by construction.** `journal.plugins.grant` and `setEnabled(…, true)` take a write token that only K2-g2's approval action mints (a module-private brand, like PV-K1e-b's `ApprovedPluginStart`). No other code can raise a grant. A source pin lists every caller of the two writers. | K2-g2 | S |
| **K2-g4** | **Condition 6.** The plugin's run start checks that the plugin's connection is still open in the service's synchronous creation step (next to `grantHolds`); the daemon session's live-connection set is the source. The same check is offered to user starts as an option. | PV-K1e-b | S |
| **K2-enable** | Turns `pluginGrants` on in the production composition. Merges only when conditions 1, 2, 3 and 5 hold, and K2-g3 and K2-g4 are on `main`. | all above, the own-shell card (OS-30), PV-K3 | S (code), plus the evidence |

Install, update, signatures and extraction (ADR 0008 decisions 7 and 8) are the other PV-K2 tickets. They propose grants and
call `grant` once per permission (decision 1). They never write the store directly, because K2-g3's token makes that impossible.

### 8.2 The six conditions mapped to their evidence

| # | Condition | Evidence that closes it | Where |
|---|---|---|---|
| 1 | The card | Own-shell UI tests. The card shows the whole escaped prompt and the project, workspace, mode, provider and model from `axis.approvals/1.detail`, and resolves through `axis.approvals/1.resolve`. A screenshot review is attached to the PR. | OS-30 |
| 2 | Every listing reader | Either the Code OSS shell is removed from the build, or a reader test feeds a listing with a `requester` and a `detail` read to every supported reader. | ADR 0011 plan, or an overlay PR |
| 3 | A real-host test | A test on the composed host with a signed plugin attestation (after PV-K3). It sends a request to the host window's pending list, reads the detail, resolves, spends, and checks the run is created as `plugin:<id>` and tainted. It also covers out of scope, ungranted, a generation change, and a closed host window. | K2-enable |
| 4 | Every grant path | K2-g3's write token, plus a test that a grant written without it is refused, and the caller pin. | K2-g3 |
| 5 | The tier | The owner's recorded decision on PV-K1e-T4. If tier 4 is chosen, a slice before K2-enable raises `PLUGIN_MAX_TIER` and teaches `PluginChallenges.prepare` the native path, with tests. | decision row, maybe a slice |
| 6 | The connection | K2-g4's test closes the host window at each step after the spend and asserts that nothing is created. | K2-g4 |

### 8.3 What each slice's PR must show

- A green gate on the PR's own head.
- The tests and mutants that section 6 lists for its methods.
- No change to the v16 or v17 migrations: their hashes stay pinned.
- For K2-g2, the final `native.confirm` summary in a test, never an intermediate string.
- For K2-enable, the evidence of all six rows above, linked in the PR body.
