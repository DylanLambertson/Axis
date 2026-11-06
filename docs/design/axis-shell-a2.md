# Shell A2: the dashboard reads the daemon

Companion to `docs/design/axis-shell.md`, `axis-shell-stage1-built.md` (A1), `daemon-host-entry.md` (X1), `docs/UX.md` and ADR 0003 (D1, D4, D6) and ADR 0004. A1 renders the dashboard and the workspace view from worktrees read off the disk. A2 makes the same views read the daemon's `list` and `status` contracts, with the A1 disk reader kept as the fallback. Nothing is restyled: the visual layer is the A1 one.

## Scope

**Wired (read only):**

| Data | Contract call | Used for |
|---|---|---|
| Projects | `axis.projects/1.list` | project groups, the Restricted Mode tag |
| Worktrees | `axis.worktrees/1.list` per project | rows, branch, locked, present |
| Dirty and ahead/behind | `axis.worktrees/1.status` for the listed ids, 100 per call | the Changes column |
| Runs | `axis.cli-runs/1.list` (newest 200) | State, Agents and Last activity columns, the attention rule |
| Approvals | `axis.approvals/1.pending` | a count in the header only |

**Not wired (stays as in A1):** every write (`create`, `finalise`, `remove`, `start`, `stop`, `approvals.resolve`); the approval card and the native confirmation (X1c and a later ticket); run output; the terminal counts (local terminals only); the local-checkout rule (decided on this machine, below); the labelled sample runs (`axis.preview.sampleRuns`), which apply only while the daemon is not the source and are never mixed with daemon runs. Events (E1) are not used; see "Polling".

## The client the shell codes against

The renderer side of the daemon connection is ticket X1b (`vscode:axisConnect`, window identity, the MessagePort brokered by main). A2 does not build it. It defines the one interface it needs, `IAxisDaemonClient` (`services/daemon/common/axisDaemonClient.ts`), and X1b registers its implementation under the same decorator:

```
status: AxisDaemonStatus            onDidChangeStatus: Event<AxisDaemonStatus>
request(contract, method, params, token?): Promise<unknown>
```

- `request` takes a contract name and method from the closed set the shell uses and plain JSON params; it resolves with the reply `result` and rejects with `AxisDaemonCallError` (a code from the closed ADR 0003 D3 set, or `unavailable` for a broken connection). The client enforces the contract's `timeoutMs`; the shell adds no timer of its own. Stacks, daemon messages and correlation ids never reach the UI.
- `status` is a closed value the client derives from what main tells it (supervisor state and failure reason, the `ready`/`degraded` message, the connection):

| `kind` | `reason` | Meaning |
|---|---|---|
| `connecting` | | spawned or reconnecting, no `ready` yet |
| `ready` | | connected, not degraded |
| `degraded` | | connected; the daemon reported `degraded` at `ready` (anchor or confirmation missing, so writes are refused). Reads work |
| `failed` | `lock_held`, `bad_config`, `pty_required`, `degraded`, `crash_loop` | the supervisor will not restart it (exit 75, exit 78, exit 78 with the `pty_required` fatal, exit 79, more than 5 crashes in 10 minutes) |
| `down` | | not started (packaged builds until X1c, `shouldStartDaemon`), stopped, or no client registered |

A value outside this table is read as `down` (`sanitizeStatus`). Until X1b lands the shell registers `UnavailableDaemonClient` (status `down`, every request rejected); X1b replaces that one registration. Nothing in the renderer decides identity or trust: the shell never sends a path, a user id, an attestation or a trust flag, only ids it received from the daemon.

## Data flow

```
IAxisDaemonClient --request--> AxisDaemonApi (validate, clean, bound)
                                     |
AxisDiscoveryDataSource (A1) ---+    v
                                AxisSnapshotLoader.load(status) --> snapshot | stale error
                                     |
AxisRefreshDriver (poll now, events later) --refresh()--> AxisWorkspaceService --> dashboard, workspace view
```

- **`AxisDaemonApi`** (`services/daemon/common/axisDaemonApi.ts`) is the only code that talks to the client. It sends fixed method names and only ids that match the journal-id pattern, rejects a reply that is not exactly the contract shape (unknown keys, wrong types, duplicate ids, too many items, a bad id), and cleans every display string the way A1 cleans branch names (control, bidi and zero-width characters become U+FFFD, length cut by code point). A bad reply is the call error `invalid_reply`. The renderer copies of the shapes stay in `axisWorkspaceData.ts` (the staging work, ADR 0005 D3, will replace the copies with `@axis/protocol`).
- **`AxisSnapshotLoader`** (`services/workspaces/common/axisSnapshotLoader.ts`) turns the status and the two sources into one snapshot: projects, entries, `origin` (`daemon` or `discovery`), pending approvals, the stale error. Rules, in order:
  1. status `ready` or `degraded`: load from the daemon. If the daemon has no project registered, use the disk reader and say so (main registers projects, X1b; until then the opened folder would vanish from the dashboard).
  2. a daemon call fails while the status is usable: keep the last daemon snapshot, mark it stale with the error code; with no earlier snapshot use the disk reader and the same marker.
  3. any other status: the disk reader (A1 behaviour), plus the status notice.
  The local checkout is decided on this machine: the disk reader finds each opened repository's own checkout and a daemon worktree whose `path` equals one of them is the local checkout. `path` is used for that comparison and for display only, and is never sent back.
- **`AxisWorkspaceService`** owns the snapshot, compares it with the previous one and fires `onDidChangeWorkspaces` only when something changed, so a poll that finds nothing new does not redraw the list or move focus. New read-only properties: `daemonStatus`, `dataOrigin`, `staleError`, `pendingApprovals` (`undefined` when unknown).
- **Polling** (`AxisPollDriver`, `services/workspaces/common/axisRefreshDriver.ts`) implements `IAxisRefreshDriver { start(refresh), stop() }`. It waits 1000 to 2000 ms after a refresh ends (uniform jitter), never overlaps two refreshes, backs off on failure (doubling, at most 16 s, back to normal on the first success), runs only while the status is `ready` or `degraded` and the window is visible, and leaves no timer behind on `stop` or dispose. Clock and random source are injected. E1 provides `AxisEventDriver` for the same interface: events call `refresh()` and a slow reconcile timer replaces the 1 to 2 s poll. The service depends on the interface only.

## What the user sees

All text is fixed and localized; no daemon text, path, secret or error message is shown. The notice is one persistent element (`role="status"`, polite) so a change is announced once and an unchanged state is not read again; it also carries the state as text, never colour alone.

| State | Notice (summary) | Rows |
|---|---|---|
| `connecting` | Connecting to the Axis service | disk reader |
| `down` | The Axis service is not running; worktrees are read from disk and no agent runs are shown | disk reader |
| `degraded` | Running in degraded mode; reads work, starting runs and approving may be refused | daemon |
| `failed` / `degraded` (79) | Stopped in degraded mode and will not restart by itself; restart Axis | disk reader |
| `failed` / `crash_loop` | Crashed repeatedly and was stopped; restart Axis | disk reader |
| `failed` / `lock_held` | Another Axis instance uses the same data; close it and restart Axis | disk reader |
| `failed` / `bad_config` | Could not start because its configuration was refused; restart Axis | disk reader |
| `failed` / `pty_required` | Cannot start yet: the terminal host it needs is not part of this build | disk reader |
| usable, call failed | The Axis service did not answer ({closed reason}); showing the last data | last daemon snapshot, marked stale |
| usable, no project registered | No repository is registered with the Axis service yet; showing worktrees read from disk | disk reader |
| usable, no worktree | A1 empty state ("This repository has no worktrees yet", Refresh) | none |
| no repository open | A1 empty state (Open Folder…) | none |

`{closed reason}` is one of: timed out, unavailable, busy, refused, invalid reply, unexpected error (a fixed phrase per code from the closed set; an unknown code reads as unexpected error).

The Changes column reads "clean", "2 staged, 1 modified, 3 untracked" and "1 ahead, 2 behind" from `status` when the daemon is the source, and "not read" otherwise (A1 text). The header gains "N approvals waiting" when `pending` is greater than zero; it is text only, with no action until the approval card exists. Refresh stays; it triggers the same refresh as a poll.

## Accessibility

Rows keep the A1 listbox, roving tab stop and per-row `aria-label`s. A refresh that changes nothing does not touch the DOM; one that does keeps the focused row by key, as A1 does. The notice and the approvals count are the only live regions; row changes are not announced one by one. The notice always says what the user can do (restart, close the other window, nothing). Everything is reachable by keyboard; no new pointer-only control.

## Security notes

- No renderer-supplied trust: requests carry ids from the daemon's own replies and fixed method names; identity stays with main's attestation (X1b).
- Every string from a reply is bounded, cleaned and set with `textContent`; a worktree path is compared and used as a tooltip source only where A1 already does, and never in a notice.
- A reply that does not match the contract shape is dropped whole and shown as "invalid reply"; partial data is never merged.
- Polling is bounded: one refresh at a time, at most 50 projects per refresh (the rest are not listed and a note says so), 100 ids per `status` call, 200 runs.
- The disk reader is unchanged and still reads metadata only; in a state where the daemon owns the data its output is used for the local-checkout rule and for the fallback rows.

## Tests

Unit tests in the overlay (Code OSS Electron runner, `./scripts/test.sh --grep Axis`): the reply validators (shape, cleaning, bounds); the status sanitizer and every notice text; the poll driver with manual timers and a fixed random source; the loader's rules with a fake `IAxisDaemonClient` (including `sameSnapshot`, which the service uses to skip a redraw); the Changes label. `AxisWorkspaceService` itself (wiring, visibility pause, focus restore) and `AxisDashboardView` have no unit test, as in A1: they need a workbench; the pure parts they call are covered. They use a fake client and no timers, so none depends on wall-clock time.

## Open questions for the owners of X1b and E1

1. Who maps supervisor events to `AxisDaemonStatus`: this design assumes the X1b client does, from a main-to-window status message.
2. Should main register projects for the opened folders (needed for rule 1 to stop falling back to the disk reader)?
3. `approvals.pending` is per window; the card (later) needs the full listing, so this ticket reads only the length.
