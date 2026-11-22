# The renderer's daemon client (PV-E0)

Status: built (ticket PV-E0, the X1b renderer replacement). Prerequisite of S3, S4, PV-D1, PV-V1, PV-V2 and PV-M5.

## What it is

Until PV-E0 the desktop renderer registered only `AxisUnavailableDaemonClient`, so every Axis view read local discovery and nothing came from the daemon. PV-E0 registers the real `IAxisDaemonClient` for the desktop build (`axis.desktop.main.ts`, after the shared entry); web and browser builds keep the unavailable client.

- **The only way to the daemon** is main's attested port: `connectAxisDaemon` asks `acquirePort('vscode:axisConnect', ...)`, main runs its sender checks and rate limit and hands the daemon a signed attestation (`main-answers.md` §2), then `hello`/`welcome`. The renderer holds no key, identity, attestation or path and stores nothing. Only `axisRendererDaemonClient.ts` imports `connectAxisDaemon`, and nothing else in the renderer calls `acquirePort` (pinned by `test/code-oss/renderer-daemon-client.test.mjs`).
- **No new capability:** the client asks for the contracts the shell already uses (`axis.projects`, `axis.worktrees`, `axis.cli-runs`, `axis.approvals`, version 1), and the daemon's own policy decides every call.
- **Reconnect** (`services/daemon/common/axisDaemonReconnect.ts`, pure): `connecting`, then `ready` on `welcome`. When the port closes (a daemon restart, a new generation) it goes back to `connecting` and reconnects at once. A refused or timed-out connect (10 s, `AXIS_WELCOME_TIMEOUT_MS`) backs off from 250 ms, doubling to 30 s with ±20 % jitter, and after 5 failures in a row (`AXIS_DOWN_AFTER_FAILURES`) the status is `down` while it keeps retrying at the cap. There is only ever one attempt in flight. A connect that answers after its bound is closed, not used.
- **Calls:** refused `unavailable` unless `ready`. Every pending call is rejected `unavailable` exactly once when the status leaves `ready`. A malformed reply (the protocol client's response check) is the closed `E_INTERNAL` and the connection stays up. Contract timeouts give `E_TIMEOUT`, and a cancelled token gives `E_CANCELLED` (the call is aborted on the port).
- **Not connected is said, never hidden:** local discovery remains only as the explicit "not connected" state. The dashboard notice reads "The Axis service is not connected. Worktrees are read from disk; agent runs, run trust and approvals are not shown." and the approvals region reads "Approvals need the Axis service. It is not connected, so none are shown." Run trust is never shown from discovery (S3's chips say "run trust unknown").
- **Out of scope:** the `axis.events/1` push transport (the protocol client ignores push frames; the shell keeps polling), failure reasons reported by main (the renderer cannot tell `crash_loop` from `not_ready`), and settings for the bounds.

## Evidence (development build on Xvfb, 2026-11-22)

The DOM was read over CDP: the notice, the approvals line and the project header. The main log is the dev build's.

| Step | Dashboard notice | Approvals line |
|---|---|---|
| Start (daemon degraded only for its audit anchor: no keychain under Xvfb) | "No repository is registered with the Axis service yet. ..." (only the daemon path produces it) | empty (usable) |
| SIGKILL of the daemon's own PID | "Connecting to the Axis service. Worktrees are read from disk meanwhile." | "Approvals need the Axis service. ..." |
| The supervisor's restart (`restart_scheduled code=9`) | back to the daemon notice, without a reload | empty |
| Five more kills in a row (`failed reason=crash_loop`: no restart) | "The Axis service is not connected. ..." | "Approvals need the Axis service. ..." |

The screenshots (`01-connected`, `02`/`03-after-kill`, `04-reconnected`, `05-not-connected`) are kept with the reviewers' evidence, not in the repository.
