# The terminal data broker (DC-3b)

- **Status:** Proposed. Security review.
- **Builds on:**
  - DC-3a (`terminals-contract.md`): the registry, `attach`, the grant in the pty process;
  - DC-3c (`terminal-trust-revocation.md`): the routing, the five-part capability whose fifth part this note provides, the lifecycle matrix;
  - OS-3 (`own-shell-main-seam.md`): main's seam, `checkAppSender`, the per-window lifetime, `window.gone`, the acknowledged pty hand-over (OS-3h).
- **Closes:** the DC-3a/DC-3c residual "`conn` is a name the caller gives". After this note a data connection exists only when main minted it for one window's current lifetime, and only that window can attach with it.
- **Not here:**
  - the terminal module in the shell (OS-16);
  - the native pty (OS-3p).

## 1. Who does what

| Party | Does | Never does |
|---|---|---|
| Main (`apps/desktop/main`) | checks the sender, mints `conn`, announces it to the daemon, waits for the acknowledgement, posts the pty end, returns the renderer end | decide a grant, read terminal data, keep either port end, log `conn` |
| Daemon | binds `conn` to a window and lifetime, decides `attach` (tier 2, policy, audit, the DC-3c reads), drops a window's conns | see a port, mint a `conn` |
| Pty process | serves a data port under its `conn` name, grants only on the daemon's control channel, closes a channel on `drop-conn` | accept a grant or a drop from a data channel |
| Renderer | asks main for a port for a terminal, then attaches it over its own daemon connection | name a `conn`, see the other end |

## 2. The flow

1. **The ask.** The renderer calls the pinned preload's existing `terminalPort(nonce, terminalId)`. It sends `axis:terminalPort { nonce, terminalId }` (`preload-contract.ts`, `parseTerminalPort`), and the preload and its pin do not change.
   - Main's handler runs `checkAppSender` (`WindowRegistry.checkAppSender`, from `senderOf`) first, before it parses the payload. The sender must be the window's main frame, not destroyed, in its current document epoch.
   - A refusal is one closed answer with nothing created.
   - `nonce` and `terminalId` are checked by the contract parser. They are carried only so the renderer can match the answer; main grants nothing.
2. **The mint.** Main makes `conn` from `crypto.randomBytes(16)`: `c_` followed by 32 hex characters. It is a capability:
   - never logged;
   - never in an audit row, a log line or an error;
   - never sent to any process but the daemon (the announcement) and the pty process (the port's name);
   - returned only to the one renderer that asked.
3. **The announcement, BEFORE any port moves.** Main sends the daemon, on its control channel, `{ type: "terminal.conn", requestId, conn, windowId, lifetime }`. It is a new supervisor-to-daemon message with a strict schema: `windowId` as `window.gone`'s, `lifetime` the window's current epoch, and `conn` the pattern above. The daemon records the binding (section 4) and answers `{ type: "terminal.conn.result", requestId, ok }`.
4. **The hand-over, only after the acknowledgement.** Main creates a `MessageChannelMain` and posts one end to the pty process as the existing `{ type: "pty-data", conn }`, unchanged.
   - It answers the renderer on the existing `axis:terminalPortResult`: `{ nonce, conn }` with the other end in the event's ports, posted to the page's own origin by the pinned preload.
   - That is all the renderer receives: one port end and one string.
5. **The grant.** The renderer calls `axis.terminals/1.attach { terminalId, conn }` over its own daemon connection: tier 2, the policy row, the DC-3c both-subject reads, the journal trust read. The daemon refuses `not_found` unless the conn table binds that `conn` to the caller's own window AND current lifetime. Only then does it send the pty process its existing `grant`.

**Why the grant stays with `attach`:** the daemon decides on one reviewed path, with its policy, audit and revocation reads. Main never asks the daemon to grant, and the pty process never grants without the daemon.

## 3. Failure paths: nothing half-made reaches a renderer

| What fails | Main does | The daemon and the pty process |
|---|---|---|
| The acknowledgement does not arrive within **5 s**, or says `ok: false` | creates no channel; answers the renderer a closed refusal | main sends `{ type: "terminal.conn.drop", conn }`; the daemon removes the binding (idempotent) |
| Posting the pty end throws | closes both ends it holds; answers a closed refusal | main sends `terminal.conn.drop`; the daemon removes the binding and sends the pty process `drop-conn` (harmless if no channel arrived) |
| The window goes (`window.gone`) between the ask and the hand-over | posts nothing; answers nothing to the gone document | `window.gone` drops every conn of that window (section 5), including this one |
| The daemon's control channel is down | answers a closed refusal at once | nothing to undo |

In every row no port reaches the renderer, and a binding that may exist is dropped at the daemon and the pty process.

## 4. The daemon's conn table

- **What an entry is:** `conn` mapped to `{ windowId, lifetime }`. `lifetime` is OS-3.2's per-window document epoch, agreed with OS-3's owner:
  - a safe integer per window, bumped on every gone, read by main at mint time with `registry.epochOf(windowId)` (`undefined`: unknown or gone, so the ask is refused);
  - `window.gone` gains `epoch`: the epoch that just ENDED (main bumps first, then sends the old value);
  - every connect identity carries its window's current epoch.
- **The epoch checks:**
  - `terminal.conn` is refused for an epoch at or below the last ended one the daemon saw for that window;
  - `attach` requires the caller identity's epoch to EQUAL the binding's.

  So a lost `window.gone` cannot leave a stale conn usable: the next document's identity has another epoch. Entries come only from `terminal.conn` on the control channel, which only main can write (section 6).
- **Bounds:** at most 32 per window and 512 in total. Past either, `terminal.conn` answers `ok: false` (fail closed).
- **An entry ends:**
  - at `window.gone` for its window;
  - at `terminal.conn.drop`;
  - when the pty process reports the data channel closed (`conn-closed`, section 5);
  - when a newer lifetime of the same window is seen.
- **What `attach` checks:** an entry for the `conn`, for the caller's `windowId` and current lifetime. A renderer reload is a new lifetime: the old document's conns were dropped with its `window.gone`, and a conn from it can never attach in the new one.
- **`attach` audit row:** `terminalId` and the ids only. **`conn` is removed from the `terminal.attach` payload and its allow-list:** a capability does not go into the audit log. This replaces DC-3a's attach row and retires that residual.

## 5. Teardown: the daemon closes a window's data channels

Main cannot close a port end once it is transferred, and how Chromium closes a navigated document's ports is not something to rely on. So:

- **`{ t: "drop-conn", conn }`**, a new pty-process control message. The service closes the data channel served under that name. That already clears its grants and owner, the merged behaviour of a closed data channel. An unknown name is a no-op. Only the control channel can send it; a data channel sending it is refused `unsupported`, as for any control message.
- **`{ t: "conn-closed", conn }`**, a new pty-process control reply. The service reports a data channel that closed on its own, so the daemon frees the entry and the table cannot fill with dead names.
- **On `window.gone`** (OS-3.2 sends it on destroyed, render-process-gone and a main-frame navigation, a reload included), the daemon, synchronously:
  - drops every conn of that window from its table;
  - sends `drop-conn` for each;
  - runs DC-3c's `windowGone` abandonment of that window's pending opens.

  A live terminal stays running and is re-attached from another window with a new conn.
- **The pty process and two ports for one conn:** it serves a name once for its whole life (`usedNames`), so a second `pty-data` for the same `conn` is closed at once. Main mints a fresh conn per ask, so this happens only if main is faulty. The pty process cannot know whether main announced a conn to the daemon, and need not: without the daemon's `grant`, a data channel reaches no terminal.
- **A data port never becomes a control port.** The pty entry's shape check is kept: one port, `pty-control` with no other key, or `pty-data` with exactly `conn`. Anything else is closed. A test pins that a `pty-data` port cannot spawn, grant, drop or kill.

### 5.1 A replaced pty control channel

OS-3h's hand-over retry replaces the pty control channel even when the daemon did not restart. The pty service then ends every terminal of the old channel: master's decision, recorded in `own-shell-main-seam.md` section 3a.
- **For DC-3b:**
  - the terminals end (DC-3a's registry sees their exits through the port's dispose, review S1);
  - the data channels stay open and keep their names, so the conn table stays valid;
  - a window re-attaches a NEW terminal with its existing conn, or asks for a new port.
- **Not in this note:** keeping terminals alive across a channel-only replacement. It would need the pty service to hand terminals to the new control channel, which OS-3h deliberately does not do.

## 6. The attestation (DC-3c's fifth part)

- **What it is:** main adds `broker: { dataBroker: true }` to the daemon's single `init` message. It is a top-level field next to `config`, never inside `HostConfig`, so no configuration file or environment value can carry it.
- **When main sends it:** only once its `axis:terminalPort` handler is installed and the pty process has adopted its acknowledged control channel (OS-3h).
- **Why it cannot be forged:** `init` arrives only on `process.parentPort`, which only the parent can write. Main is the only parent: it forks the daemon from the fixed bundle file. The pty process and every child the daemon starts have no handle on it. The daemon accepts exactly one `init`, checks it strictly, and refuses a second. A plugin, a web client or a renderer can reach neither the parent port nor `init`.
- **How it is used:** `daemon-host/src/entry.ts` reads `broker` from the parsed `init` and passes a `TerminalDataBroker` to `composeDaemonHost`. Only then does the five-part predicate hold, and `axis.terminals/1` is served.
- **An older main, or a test main without the broker,** omits the field, and the contract stays unserved.

## 7. With DC-3a and DC-3c

- **`attach`:** it still records the attaching window for revocation routing (DC-3c section 3). It now also requires the conn to be bound to that window and its lifetime (section 4).
- **A registry revoke:** still revokes per terminal, permanently, in the pty process. A revoked terminal's viewer is told `exit` on its data channel, which stays open for that connection's other terminals.
- **`window.gone`:** now also drops the window's conns (section 5). Its DC-3c row in the lifecycle matrix gains that column.
- **The DC-3c residual "conn is caller-named until DC-3b" is closed.** The note and the contract say so in the same change as the code.
- **Unchanged:** the cap of 16 plain terminals, the 8 per workspace, and the both-subject admission.

## 8. What the code adds, in order

1. **First commit, the DC-3c code review 2 nits:**
   - the nested-revoke queue drains iteratively at the outermost dispatch, with a total bound, and the note's "nothing recurses" is corrected;
   - the cap test with 16 PENDING reservations;
   - room in `compose.ts` (the wiring goes in `terminals/compose.ts`).
2. **The daemon side:**
   - the `terminal.conn`, `terminal.conn.result` and `terminal.conn.drop` schemas;
   - the conn table;
   - the `attach` binding check;
   - `window.gone` dropping conns;
   - the `init` `broker` field read in the entry;
   - `conn` out of the attach audit row.
3. **The pty process:** `drop-conn` and `conn-closed`. These are daemon-and-pty messages on the control channel itself (the service's `t:` protocol), not OS-3h's parent-port messages, so the shapes do not conflict. They are based on OS-3h's branch, which also changes `service.ts` (the latest control channel wins).
4. **Main's broker (after OS-3.2 merges):**
   - the `axis:terminalPort` handler body (OS-3.2's checked closed refusal, replaced). The preload, its contract parser and the exact pin in `apps/desktop/test/preload-pin.test.mjs` are unchanged; a change to them would go in the same diff and be reviewed with OS-2's owner;
   - the 5 s acknowledgement wait and the failure paths;
   - the `init` field.

## 9. Must prove (each with a mutant)

- **The binding:** `attach` refuses a conn of another window, of an older lifetime of the same window (the caller's epoch differs even when no `window.gone` arrived), one never announced, and one after `terminal.conn.drop`, `window.gone` or `conn-closed`. `terminal.conn` for an ended epoch is refused. Removing each check must let a grant through.
- **Teardown:** with the real pty service, `window.gone` drops every conn of that window. A viewer on one gets no more output and cannot write. Another window's conn on the same terminal is unaffected.
- **A replaced control channel:** the conn table survives, a new terminal attaches with an existing conn, and an old terminal's grant is gone.
- **Main's broker, Electron-free over MessageChannel fakes:**
  - `checkAppSender` runs before the payload is parsed;
  - conns are unique and from the crypto source;
  - nothing is posted before the acknowledgement;
  - exactly one port goes to the pty process and one to the renderer, with only the conn string beside it;
  - each failure path in section 3 posts nothing to the renderer and drops the conn.
- **The attestation:**
  - through the real entry path, an `init` without `broker` is not served, and with it is served;
  - a `broker` inside `config` is ignored or refused, never honoured;
  - a second `init` is refused.
- **The bounds:** 32 per window and 512 in total, with the overflow refused.
- **The pty messages:** `drop-conn` on an unknown name is harmless; a data channel cannot send `drop-conn`; `conn-closed` frees the daemon's entry.
- **Audit:** the `terminal.attach` row through the host's merged allow-list carries no `conn`.
- **The capability string:** no log line, audit row or error text contains a minted conn (a test scans them).
