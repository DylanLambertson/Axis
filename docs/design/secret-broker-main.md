# Main's secret store in the own shell (ticket PV-N0c-2, own-shell OS-3.3)

- **Status:** proposed (docs only). The contract the PV-N0c-2 adapter and its flip are built and reviewed against.
- **Builder:** OS-3.3 (OS-3's builder), after OS-3.2; contract: this note. The flip (§6) is PV-N0c-2's last pull request.
- **Decides** one thing (the provider connection id, §6.1). Everything else restates `secret-broker.md` (§3, §5, §6.1) and
  the handoff list of its §3.4 as testable requirements for main, and places them in the own shell (ADR 0011).
- **Related:**
  - `docs/design/secret-broker.md` (the broker design, gate lines 1 to 8, the guarantees main gives in §3.4: items 1 to 7 on
    main today, items 8 and 9 and the "What PV-N0c-2 must still prove" list of §6.1 arrive with PV-N0c-1 slice (b), whose pull
    request is open; §4 and §5 below restate all of them, so this note stands on its own);
  - `docs/design/own-shell-main-seam.md` (the OS-3 split; this is the secret half of slice 3.3);
  - `docs/design/own-shell-plan.md` (OS-3.3, OS-27 the development and CI keyring rig);
  - `packages/daemon-host/src/main/secret-store.ts` and `secret-files.ts` (PV-N0a: the store and the record folder, built);
  - `packages/daemon-host/testing/secrets-main.ts` (`FakeSecretsMain`: the model the daemon side is tested against).

## 1. What exists and what is left

| Part | Where | State |
|---|---|---|
| Record format, frame, name binding, weak refusal, `v11` check on Linux, per-name serialization, budgets and limits, closed errors and events | `daemon-host/src/main/secret-store.ts` | Built and tested with a fake cipher (PV-N0a) |
| The record folder on the real file system: folder checks, no-follow reads, atomic durable writes, temporary-file cleanup | `daemon-host/src/main/secret-files.ts` | Built and tested on a real temporary directory (PV-N0a) |
| The daemon's backend, its reconciliation and the startup reveal, behind an option that is off | `daemon-host/src/secrets-backend.ts`, `compose-secrets.ts` | Built (PV-N0c-1) |
| **The cipher adapter:** `safeStorage` as the store's `SecretCipher` | `apps/desktop/main/` | **PV-N0c-2** |
| **The wiring:** one store per app under `<base>/secrets`, started once, answering `secrets.*` on the daemon's control channel | `apps/desktop/main/seam.ts`, `startMainSeam`: the `DaemonSupervisor`'s `onRequest` is the branch point | **PV-N0c-2** |
| **The conformance run** of §4 against the real store | `apps/desktop/test/` | **PV-N0c-2** |
| **The flip** (§6) | `packages/daemon-host/src/entry.ts` | **PV-N0c-2, last** |

## 2. What main implements

- **The cipher adapter.** `status()` is `{ available: safeStorage.isEncryptionAvailable(), backend }`, where `backend` is
  `getSelectedStorageBackend()` on Linux and `macos_keychain` or `windows_dpapi` elsewhere. `encrypt` and `decrypt` are
  `encryptString` and `decryptString`. It is structural over a `SafeStorageLike`, as OS-3.1's `safe-storage.ts` is, so the tests
  run it without Electron. It never calls `setUsePlainTextEncryption`.
- **The store**: `createSecretStore({ cipher, files: createSecretFiles(secretsDirPath(base)), platform, timers, onEvent })`, ONE
  per app. `start()` runs once before the daemon is forked (it checks the folder and removes leftover temporary files).
  `onEvent` maps the closed `SecretEvent` names to main's log, nothing else.
- **The routing.** Every daemon-to-main request goes `DaemonSupervisor.onRequest` to `createMainAnswers` (`daemon-host/src/main/answers.ts`), wired in `seam.ts`'s `startMainSeam`; nothing answers `secrets.*` today, so such a request is simply unanswered. N0c-2 branches in `onRequest`: `secrets.*` go to the store, everything else to `createMainAnswers` as now, so the answers module stays window and anchor only.
- **The answers.** A `secrets.*` message from the daemon is parsed with `daemon-host/src/control/secrets-messages.ts` (already in
  `main.cjs`'s graph). It is handed to `store.handle`, and the answer is sent as one `secrets.result` with the same `requestId`.
  The answer object is built fresh for each message (guarantee 7). A message that fails the schema gets no answer; the daemon
  times out (`backend_failed`). Main logs closed event names only: never a name, a secret, a path or an exception text.
- **Nothing else crosses.** No renderer path, preload function or IPC channel reaches the store or `safeStorage`; a source pin
  in the OS-3.3 tests proves it.

## 3. The messages

The six requests and their answers are `secret-broker.md` §3.4's table; the schemas are `secrets-messages.ts`. Every answer is a
value of the request's own kind, or one closed error:

| Error | Means | For a `put` |
|---|---|---|
| `not_found` | no record of that name | nothing was written |
| `refused` | weak or unavailable backend, a write that would land elsewhere, a `v10` ciphertext on Linux, or the 256-entry cap | nothing was written |
| `corrupt` | a record that is not this name's exact frame, an unknown prefix, bad JSON or metadata | nothing was written |
| `failed` | a file-system or cipher failure, a full queue, or the budget ran out | **unknown**: a late write may still land (the daemon reconciles) |

## 4. The nine guarantees, as requirements with tests

`FakeSecretsMain` is the executable specification of what the daemon relies on. A shared **conformance scenario list** in
`packages/daemon-host/testing/secrets-conformance.ts` runs each scenario through the daemon's REAL backend, against a "main"
the caller supplies. `daemon-host` runs it against `FakeSecretsMain`; `apps/desktop` runs the same list against the real store
with real files and a fake `safeStorage`. So neither side can drift from the other.

| # | Requirement (main) | Scenario in the list |
|---|---|---|
| 1 | One operation per name; a running one keeps its name until its work settles, even after it answered `failed` | A late `put` then a `get` for the name: the `get` sees the late write |
| 2 | A request answered `failed` while waiting never runs | A `put` queued behind a hung one, its budget passed: no record afterwards |
| 3 | Only `failed` may mean "maybe written" | `refused`, `corrupt`, `not_found` answers to `put`: the record is unchanged |
| 4 | A `put` whose `meta.backend` or `meta.protection` is not where main would write is refused, never written | `put` with another backend's meta: `refused`, no file |
| 5 | Budgets from accept (60 s for `get` and `put` on macOS and Linux, 5 s otherwise); 4 waiting, 6 outstanding; `info` never queues; 2 file operations at once | Six requests on one hung name; `info` answered while every slot is held |
| 6 | `get`, `meta` and `list` report protection from the ciphertext | A `v10` record placed by hand reads `none` (Linux) |
| 7 | No shared reference inside an answer | Every answer survives a structured-clone round trip unchanged |
| 8 | Each start: a `list`, then an `info` and a `get` per provider entry; the `list` includes integration entries | The startup reveal against a store holding both kinds |
| 9 | A weak record's plaintext reaches the daemon on every start | Covered by gate 7 (§5): the canary run includes a weak provider record |

- **The desktop app consumes the list** through a test-only export of `@axis/daemon-host`, `./testing/secrets-conformance`,
  under a `"test"` export condition (`node --conditions=test`). The production bundle is built without that condition, so it
  cannot resolve the subpath. **OS-3.3 test requirement:** `apps/desktop/test/bundle.test.mjs`, which already pins `main.cjs`'s
  `daemon-host` inputs to an exact list, its byte budget and the exports map, gains an explicit assertion that no bundle input
  path contains `/testing/` and none is a conformance-scenario file (it has no export-condition hook today).
- **Guarantee 5's thread cap** (2 file operations at once) is the store's own; the conformance list checks it through timing
  only (a hung third operation waits), never by counting threads.

## 5. Before the flip: what N0c-2 proves

From the N0c-1 slice reviews (`secret-broker.md` §6.1 gains the same list with slice (b)):

- **Gates 1 to 5 in a built app** (Linux first, §6.2): a key stored through the broker is read back by the providers binding,
  and no file under `<base>/daemon`, the journal or renderer state holds it; `0600` records in a `0700` folder; a moved record
  reads `corrupt`; Linux `basic_text` refuses every store with the visible reason; a hand-placed `v10` record reads `none` and
  is refused by the vault. These need a real keyring: **OS-27's rig is a hard dependency of the flip, not of the adapter.**
- **Main's share of gate 7**: a canary through the real main-to-daemon path, capturing main's diagnostics and errors as well as
  the daemon's logs, covering a cipher failure, late and failing answers and the startup reveal's read of a weak record. A
  mutant that leaks the canary at the adapter's boundary (an answer, an event, a log line) must fail it.
- **Crash injection at each write step**, on the real file system (owned by the OS-3.3 builder): a kill after the temporary
  file is created, after its `fsync`, after the `rename` and before the folder `fsync`, and during a `remove`. After a restart:
  the old record or the new one, never a mix; no temporary file left once `start()` ran; a temporary file is never read as a
  record.
- **A cipher that changed between runs** (the keyring was deleted or replaced after a `v11` record was written): `get` answers
  `failed` when `decryptString` throws and `corrupt` when it returns anything but the exact frame. Never plaintext, never a
  fallback key, never a silent delete. The daemon shows "needs reconnect" (gate 6) and the record stays.
- **Gate 6 with a real hung file operation** (a FIFO or a stalled mount in the test): the request fails within its budget and
  other names stay usable.
- **The N0c-1 slice (b) re-check nits**, fixed in the daemon before the flip: one startup-wait deadline counted from ready (not
  10 s per request); a behavioural test that the read in flight at shutdown gets its 1 s before the seal; the wait timer
  unref'd.

## 6. The flip

### 6.1 The provider connection id [D]

The entry passes `secretBroker: { connectionId: "anthropic" }`: a fixed id under the vault's name rule, set in the entry only,
never from settings, the environment or the renderer. **Why:** the daemon serves one provider connection today, and a
configurable id would be an input that chooses which stored secret the composer reveals. A second provider connection means a
second id in the entry (an entry-side map) or a second backend instance; it is not made configurable now. Decided by the project
lead on 2026-11-28 under the owner's delegation; the owner is told that the first provider connection is fixed.

### 6.2 Per platform

The flip is per platform: the entry turns the broker on only on a platform whose adapter evidence (§5) exists.

| Platform | Evidence | Broker on at the flip |
|---|---|---|
| Linux | §5 in a built app with OS-27's rig (libsecret, and `basic_text` for the refusal) | Yes |
| macOS | Keychain prompts and the sheet behaviour are not exercised by any test here | No, until its own evidence |
| Windows | **Not verified:** DPAPI through `safeStorage`, and the claim that the record files inherit the profile folder's ACL (`secret-broker.md` §3.1), are not tested anywhere | No, until its own evidence |

Where it is off, the daemon behaves as today: the composer serves the mock only and the integrations show `available`.

### 6.3 The change and the pins it inverts

- **One line** in `packages/daemon-host/src/entry.ts`: the composition call gains
  `...(BROKER_PLATFORMS.has(platform) ? { secretBroker: { connectionId: "anthropic" } } : {})`, with `BROKER_PLATFORMS` a frozen
  set holding `"linux"` at the flip.
- **Inverted on purpose, in the same pull request:**
  - `test/integrations/handlers.test.ts` "the daemon entry never turns the secret broker wiring on" becomes "the entry turns it
    on with exactly this field and id, only for the listed platforms";
  - its "no integrations option" pin stays as it is: the entry still passes no `integrations` option (the broker backend reaches
    the integrations binding through the composition, not the entry).
- **Kept:** the composition-level tests with the option absent (`test/slice/secrets-broker.test.ts` "off") still prove zero
  sends; they now stand for the unlisted platforms.
- **New with the flip:** a built-app check that every `secrets.*` request the daemon sends is answered by main (no daemon
  timeout in a normal start), and a test that the flip changed nothing but the entry line and the inverted pins (the diff of
  the pull request is checked by its reviewer against this list).

## 7. Open items

- If OS-3.2 splits `seam.ts` for the line limit, the branch point of §2 moves with `startMainSeam`; OS-3's builder names the file.
- macOS and Windows evidence: separate tickets after the Linux flip.
