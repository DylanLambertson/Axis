# The plugin grant contract (ticket PV-K2, grant part)

- **Status:** design only, not built. Date 2026-11-26; revised 2026-11-27 after review 1 and the decisions of
  2026-11-26 (owner delegation, reversible).
- **Scope:** who may write `plugin_enablement` and `plugin_grants` (journal v16, PV-K1b), through which calls, what each write is
  bound to, and what a revoke or a disable ends.
- **Not in scope:** install, update, signatures and extraction are the rest of PV-K2 and follow ADR 0008 decisions 7 and 8
  (designed in `plugin-install.md`). They create the plugin's row and propose grants; they grant only through the calls below
  (section 1, condition 4).
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
   and asserts that nothing is created. **Precondition of this condition** (2026-11-27, owner delegation): the own shell's main
   sends the daemon `window.gone` when a window is destroyed, when its renderer dies, and when its main frame starts a navigation
   (a reload included; own-shell plan OS-3). Until then a window's lifetime ends at its last connection's close, so a renderer
   death that no connection reports, or a reload whose new connection arrives before the old one's close, is missed
   (section 8.4).

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
- **The project name comes last**, and the user chose it: at most it can add look-alike wording at the END of the line, after
  the wording and the plugin, which it can never displace or cut (review K2-g2 N4).
- **The short id must be widened before K2-enable** (review K2-g2 N2). Six hex digits are 24 bits, and an id whose first 12
  characters and short hash collide with another's can be found in seconds. Before the grant calls are switched on, the short
  form carries more of the hash, or the dialog shows the whole id; the card shows the whole id either way.
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
- a run started before the revoke keeps running (in K2-g2, which can start a plugin run; K2-g1 cannot make one);
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
4. **The grant token's guarantee stops at the serving store** (2026-11-27). Code that holds a writable database handle is in the
   trusted base. The construction rule limits where the database, the journal and the store are constructed, naming the allowed
   site for each (section 8.4); it does not confine who holds a handle afterwards. A per-database authority, which would
   refuse a second store over the same handle, is not built; it stays open as option (a).

## 8. Implementation plan

Six slices, each its own PR with a security-critical review. The first five can merge while the grant calls stay switched off;
the sixth (K2-enable) switches them on, and only once all six conditions of section 1 hold. Today nothing in production writes a grant: only
tests call `journal.plugins.grant` and `setEnabled`.

### 8.1 Slices

| Slice | What | Depends on | Size |
|---|---|---|---|
| **K2-g1** | `axis.plugins/1` in the protocol with `list`, `revoke` and `disable` handlers; the policy rows (user only; outside `WEB_ALLOWED`; `axis.plugins/` added to `PLUGIN_DENY_CONTRACTS`); `approvals.endPlugin(pluginId, projectId)`. **Built.** A revoke of a permission not granted answers `E_NOT_FOUND` (`not_granted`) and changes nothing; a disable of a plugin already off answers its unchanged state. | PV-K1e-b (merged) | M |
| **K2-g2** | `grant` and `enable` at tier 4: the content hook (the versioned tuple digest, the project mutex at the spend), the native line builder of section 3.1, and `already_granted`. Registered but switched off: the handler refuses with `E_UNAVAILABLE` unless the host option `pluginGrants` is on, and it is off in production. **Built, off.** An enable of a plugin already on is refused at issue (`already_enabled`), as a grant that exists is (`already_granted`); neither shows a dialog. It provides none of the six conditions' evidence (section 8.2): K2-enable stays blocked. | K2-g1 | M-L |
| **K2-g3** | **Condition 4, by construction.** The journal mints grant tokens and hands its minting function out once (`takeGrantMint`), to the approved action at wiring time; `grant` and `setEnabled(…, true)` refuse any write without a token of that instance (section 8.4). **Built.** The writer and construction rules live in `test/packages/plugin-grant-writer-rule.mjs` and run in the gate's import walk; the second-open residual is RR-96. | K2-g2 | S |
| **K2-g4a** | **Condition 6, the daemon part.** The lifecycle hook in `@axis/daemon` (`DaemonOptions.lifecycle`: `accepted`, `closed`, once per attested session); the strict `window.gone { windowId }` control message and its shell-independent sender in `daemon-host/src/main`; `WindowLifetimes` (epoch, counts, the ring of ended epochs, `alive`) with the epoch-rule tests. Not wired into the Code OSS seam (section 8.4). **Built.** `DaemonOptions.lifecycle` calls `accepted` before any message the session queued during the handshake is handled, so a close those messages cause always comes after it; a throwing hook is reported (`lifecycle`) and ignored. `plugins/window-lifetimes.ts` keeps a set of connection ids per live epoch, so a duplicate accept or close counts once and a late close of a connection from an ended epoch changes nothing; an epoch that cannot be drawn fresh leaves the window with none (fail closed). The supervisor posts `window.gone` only while the host runs and only a `w<n>` id the inbound schema accepts; `main/window-lifecycle.ts` is the sender the own shell calls. The composition does not create `WindowLifetimes` yet: K2-g4b wires it with the binding that reads it. | PV-K1e-b | M |
| **K2-g4b** | **Condition 6, the binding and the checks.** `PluginChallenges` pins the host window's epoch at issue; `valid()` requires it alive; `ApprovedPluginStart` carries it; the three start checks (handler entry, the mutex, the service's synchronous step) test it and the plugin connection's signal; the tests at each await after the spend: plugin close, last host close, close then reopen, `window.gone`. **Built.** A host window with no live epoch refuses the challenge at issue (nothing issued or counted); every later check calls `alive()` with the pinned epoch, so an ended or unknown epoch is closed, and a throw is too. The pending listing ends a plugin challenge whose binding no longer holds, so a reopened window never lists a card from the lifetime before. The handler refuses `host_window_closed` (`E_CANCELLED` for the plugin connection) at entry, before waiting for the mutex, and again under it; it hands the same check to the service as `hostAlive`, required for a plugin start and checked right after `grantHolds`. The composition creates `WindowLifetimes`, passes it to the daemon as `lifecycle` and to the binding and the handler, and ends a lifetime on `window.gone`. Pausing at the policy row (where a closed plugin connection is stopped by the daemon itself), the mutex wait and the trust gate is tested with each of the four events; the model list and `engine.prepare` come before the service's synchronous check and are covered there. | K2-g4a | M |
| **K2-enable** | Turns `pluginGrants` on in the production composition. Merges only when conditions 1, 2, 3 and 5 hold, and K2-g3, K2-g4a and K2-g4b are on `main`. Also before it merges: the dialog's short plugin id is widened, or the whole id is shown (section 3.1, review K2-g2 N2). | all above; OS-30; PV-K3 | S (code), plus the evidence |

Install, update, signatures and extraction (ADR 0008 decisions 7 and 8) are the other PV-K2 tickets. They propose grants and
call `grant` once per permission (decision 1). They never write the store directly, because K2-g3's token makes that impossible.

### 8.2 The six conditions mapped to their evidence

| # | Condition | Evidence that closes it | Where |
|---|---|---|---|
| 1 | The card | OS-30's own-shell UI tests: the strict reader for `pending` with `requester` and for `axis.approvals/1.detail`, and the card showing the requester, the whole escaped prompt and the project, workspace, mode, provider and model before Approve, resolving through `axis.approvals/1.resolve`. A screenshot review is attached to the PR. | OS-30 (`own-shell-plan.md`), a security review |
| 2 | Every listing reader | Either the Code OSS shell is removed from the build, or a reader test feeds a listing with a `requester` and a `detail` read to every supported reader. | ADR 0011 plan, or an overlay PR |
| 3 | A real-host test | A test on the composed host with a signed plugin attestation. It sends a request to the host window's pending list, reads the detail, resolves, spends, and checks the run is created as `plugin:<id>` and tainted. It also covers out of scope, ungranted, a generation change, and a closed host window. | K2-enable, after PV-K3 (section 8.5) |
| 4 | Every grant path | K2-g3's write token, plus a test that a grant written without it is refused, and the caller pin. | K2-g3 |
| 5 | The tier | The owner's recorded decision on PV-K1e-T4. If tier 4 is chosen, a slice before K2-enable raises `PLUGIN_MAX_TIER` and teaches `PluginChallenges.prepare` the native path, with tests. | decision row, maybe a slice |
| 6 | The connection | K2-g4b's test closes the host window at each step after the spend and asserts that nothing is created. | K2-g4a, K2-g4b |

### 8.3 What each slice's PR must show

- A green gate on the PR's own head.
- The tests and mutants that section 6 lists for its methods.
- No change to the v16 or v17 migrations: their hashes stay pinned.
- For K2-g2, the final `native.confirm` summary in a test, never an intermediate string.
- For K2-enable, the evidence of all six rows above, linked in the PR body.

### 8.4 Two details the slices must get right

**K2-g3: no second writer.** The locks are of two kinds, and only the runtime ones are a guarantee. The static rules catch
ordinary mistakes and leave a reviewed boundary, as the existing principal precedent says of itself (ADR 0005, on wrappers and
indirect flows).

**The trust boundary** (decision 4, section 7):
- **What the guarantee covers:** code that reaches the **serving** store, the `journal.plugins` of the journal the host
  composition opened. Through that store, a grant needs a token, and only the approved action can mint one.
- **What it does not cover:** code that holds a writable database handle already has full authority. It can write
  `plugin_grants` rows with raw SQL, since the triggers check only their shape. It can also open a second `Journal` over the same
  handle, whose store has its own untaken mint.
- **The answer to that is containment, not the token.** The construction rule below limits where the database, the journal and
  the store are constructed, naming the allowed site for each. It does not confine who holds a handle afterwards: the host
  composition, which is trusted, passes the handle on. Code that gets a handle is in the trusted base, and its review is the
  control.

*Runtime locks:*

1. **Who can make a token: the journal alone, and it hands the minting power out once.**
   - The token, its brand (a `WeakSet` private to the store instance), the minting function and the check all live inside
     `PluginGrantRecords` in the journal. Nothing in the daemon host holds the brand, and the journal imports nothing from the host,
     so the package boundary (`imports.test.mjs`) stands.
   - `journal.plugins.takeGrantMint()` returns the instance's minting function **once**, and a second call throws. The host
     composition calls it at wiring time, before the daemon serves any request. It passes the result straight to
     `createGrantAction(…, mint)`, which keeps it in the approved action's closure and nowhere else.
   - If any other code took the mint first, the composition's own call throws and the host does not start. The theft is a visible
     startup failure, never a silent second writer.
   - A degraded start (the host up without a writable journal) never takes the mint, and it serves no writable journal either: the
     handlers that write are registered only for a writable host. So nothing can mint there (review K2-g3 N5).
   - **No enrolment.** The minting function takes no argument: it creates a fresh frozen token object, adds it to the brand and
     returns it. Nothing can enrol an object it brings, and the store never exports its check, so no verifier exists that a caller
     could use or misuse.
   - **The write.** `grant` and `setEnabled(…, true)` take a token. The store accepts only a token in this instance's brand, and
     removes it from the brand before writing, so it is spent once. A forged object, a token of another journal instance, or a
     spent token is refused.
   - `revoke` and `setEnabled(…, false)` need no token: a decrease applies at once.
2. **No escape of the mint.** `grant-action.ts` exports exactly one name, the action factory. A wrapper that forwards the mint or
   a token is a new export, which the export rule below refuses.

*Tests of the runtime locks:*
- the mint is taken once, and a second `takeGrantMint()` throws;
- a token from journal A is refused by journal B;
- a forged look-alike object is refused, and so is a spent token;
- a grant without a token is refused;
- on the composed host, after startup `takeGrantMint()` throws, which proves nothing can obtain the mint later.

*Mutants:* a check that accepts any object; the token not spent; a second take allowed; the composition not taking the mint at
startup.

*Static rules*, in `test/packages/plugin-grant-writer-rule.mjs`. They are wired into the existing source walk of
`test/packages/imports.test.mjs`, so they run in the gate's tests step on every package's source, not only as helper unit tests.

- **Imports and the mint, resolved.** Every import and re-export is resolved to a file, whether it is a package specifier, a
  relative path or a barrel. Only `grant-action.ts` may import it, and only the host composition file may call `takeGrantMint`,
  as the direct argument of `createGrantAction`.
- **Call sites, whatever the type** (review K2-g3, round 2). Outside the files allowed for each member, any access, element
  access (a literal key, or a computed one) or destructuring of a callable member named `grant`, `setEnabled` or
  `takeGrantMint` is refused, whatever type the receiver has been given: the store, a `Pick<>`, a structural view, a union, a
  container, a promise's result, a generic. This includes calls through `call`, `apply` and `bind`.
  - It is not refused when the receiver is the grant action, or for `setEnabled(…, false)`, a decrease, which is allowed
    anywhere.
    - The grant action is recognised by its declaration in `plugins/grant-action.ts`, never by its name, so a local type that
      happens to be called `GrantAction` is not exempt (review K2-g3, round 3).
  - Destructuring is checked in every position: a `const`, a parameter, a `for-of`, a pattern nested in another, and assignment
    patterns (`({ grant: g } = x)`, nested ones and `for ({ … } of …)`).
  - A data field that happens to be named `grant` is not callable, so it is never flagged.
  - This replaces chasing the shapes a value can flow through: whatever path the store takes, its increase members can only be
    reached by name at a call site, and every such site is checked.
  - Passing a `PluginGrantRecords` value to a function is also flagged, unless the callee is the grant action's factory.
- **Exports.** `grant-action.ts` exports exactly one name.
- **Construction.** Only `daemon-host/src/host.ts` may call `Journal.open` or the storage port's `openDatabase`. Only
  `audit/src/db.ts` and `daemon-host/src/storage/node-storage.ts` may call the audit package's `openDatabase`. Only
  `journal/src/journal.ts` may construct `PluginGrantRecords`. That is where they are today. Tests are exempt here, since every
  test opens its own database.
- **Allowed files:** `grant-action.ts`, the host composition (for `takeGrantMint` only), the `axis.plugins/1` handlers (revoke
  and disable only), the store itself, and one named test helper.
- **The rule's own tests** plant every bypass form that a static rule can see, and each must fail through the real source-walk
  entry:
  - an alias, destructuring, bracket access, a helper that receives the plugins object;
  - a wrapper export, a second caller of `takeGrantMint`, a re-export, and a barrel;
  - a second `Journal.open`, a `new PluginGrantRecords`, and an `openDatabase` call outside the allowed files.

**The boundary.** The static rules cannot prove anything about code that launders the store through `any` or a name built at
run time. The runtime locks hold only for the serving store; they do not hold for code that holds the database handle (the trust
boundary above). Such a writer would have to change `grant-action.ts`, the composition or a construction site, which these rules
pin and review sees.

**The residual, recorded:** a second journal or store opened over the serving database, or raw SQL from code that holds the
handle, can write a grant without a token. K2-g3 adds this as RR-96 in the residual register. Its compensating controls are the construction rule and review. A test pins the residual as it stands: it shows that a
second `Journal.open` over the same handle can mint. If a per-database authority is chosen later (option (a) of review 3), that
test flips and the row closes.

**K2-g4 (a: the daemon part; b: the binding and the checks): a closed connection or host window stops the start.**

- **The plugin connection.**
  - When it closes, the daemon aborts every in-flight request of that connection (`session.ts` `close()`), and the handler's
    `context.signal` is that request's.
  - The service checks the signal after `engine.prepare`, and K2-g4b checks it again inside the synchronous creation step, next
    to `grantHolds`.
- **The host window: lifetimes, not counts.**
  - The window id `w<n>` stays the same across a renderer reload or reconnect (main derives it from the code window), so it
    cannot tell two lifetimes apart. The daemon therefore keeps, per window id, a lifetime **epoch** and a count of accepted
    desktop connections within it:
    - the first accepted desktop handshake of a closed window starts a new epoch, an unguessable value never reused;
    - more connections only raise the count, and closing one of several lowers it, so the epoch stays;
    - the last close ends the epoch for good;
    - a rejected handshake changes nothing;
    - a close reported twice is counted once.
  - **Where the counts come from:** a lifecycle hook in `@axis/daemon`, `DaemonOptions.lifecycle` with `accepted(identity)` and
    `closed(identity)`. It is called once per attested session, since only the daemon knows when a session was attested and when
    it closed. The host's `WindowLifetimes` keeps the epochs from it, with a bounded ring of ended epochs so an ended one is
    answered as ended, not as unknown.
  - **Unreported death.** Main owns the window lifecycle. A shell-independent sender in `daemon-host/src/main` sends the daemon a
    strict `window.gone { windowId }` control message, which ends that window's epoch even if a connection's close was never
    reported. Main calls it when a window is destroyed, when its renderer dies, and when its main frame starts a navigation
    (a reload or any other navigation, not a same-document one).
    - The Code OSS seam does **not** call it: the owner stopped new Code-OSS-only work (2026-11-27). The own shell's main
      (OS-3) wires it, and that wiring is a precondition of condition 6.
    - Until then the epoch ends at the window's last connection close, and only a renderer death that no connection reports, or a
      reload whose new connection arrives before the old one's close, is missed.
  - **A reload** (review K2-g4a: the reload overlap). The window id stays the same, and the new document may connect before the
    old document's connections report their close, so counting connections alone would carry the epoch across the reload. The
    daemon does **not** end the epoch when a new connection arrives while another is open:
    - it cannot tell a reload from a second connection of the same document, and a window legitimately holds several, so the
      epoch would churn and end approvals for nothing;
    - instead main, which sees the navigation, ends the lifetime. It sends `window.gone` at the start of the main frame's
      navigation, before the new document can ask for a connection. That message and the new document's `connect` travel the same
      ordered control channel, so the host ends the old epoch before it sees the new connection;
    - the old connections' closes that arrive later change nothing: `WindowLifetimes` keeps each epoch's own connection ids.
    - This matters because a plugin view is a separate view main owns and can outlive a host reload, so its own connection's close
      does not cover one. Until OS-3 wires the sender, a reload with that overlap continues the epoch. What still bounds it: the
      approval needs the user's resolve in that window, the grant generation is checked, the plugin connection's own signal, and
      the challenge's lifetime.
- **Pinned at issue.** The plugin's challenge binding records the host window's epoch when the challenge is issued.
  - `valid()` fails when that epoch has ended, so resolve, detail and the spend refuse a challenge whose window closed even once,
    including a close followed by a reconnect.
  - The binding hands the epoch to the handler inside `ApprovedPluginStart`, with the generation.
- **When it is checked,** always against the pinned epoch, never a fresh snapshot:
  1. at handler entry, after the daemon's awaited execute audit row;
  2. under the project mutex, before the trust gate;
  3. in the service's synchronous creation step, with `grantHolds`, after the trust gate, the provider's model list and
     `engine.prepare`. No await separates this check from the record.

  A failure refuses the start with a closed reason (`host_window_closed`; `E_CANCELLED` for the plugin connection) and creates
  nothing.
- **Tests:**
  - the epoch rules: two connections to one, one to none to one, a rejected handshake, a close reported twice, and `window.gone`
    while a connection's close was never reported;
  - pausing at each await after the spend (the audit row, the mutex wait, the trust gate, the model list, `engine.prepare`),
    with three cases at each: the plugin connection closes, the host window's last connection closes, and the host window
    closes then reconnects. No run may exist in any case.

### 8.5 The PV-K3 ordering

PV-K3 (the plugin host) needs a plugin it can load, so it depends on PV-K2's **manifest and install** slices, with the grant calls
still off. It does not depend on K2-enable. The order is:

1. PV-K2's manifest, install and K2-g1 to g4 merge, grants off;
2. PV-K3 merges;
3. condition 3's real-host test is written on PV-K3;
4. K2-enable merges last.

The tickets table's PV-K2 and PV-K3 rows are reconciled to say the same: PV-K2's "must not enable" applies to the grant calls and
K2-enable, and PV-K3 depends on PV-K2's disabled slices only.
