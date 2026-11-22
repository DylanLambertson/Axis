# Project trust: GUI evidence (S4)

Status: recorded 2026-11-22 on the development build on Xvfb (Linux). It covers S3 (`feat/prt-s3`, #612) and S4 (`feat/prt-s4`): main's native dialogs, pressed with real X input. Design: `project-registration-and-trust.md` §4, §9 (S4) and §10.

## Rig (test tooling only, never in CI or the product)

- **Input:** `xdotool` as recorded in `pty-exec-node.md` §8. The window close is sent as a window manager would send it: a `WM_PROTOCOLS` / `WM_DELETE_WINDOW` client message (Xvfb runs no window manager). Destroying the dialog's X window from outside is not a close: GTK reports "GdkWindow unexpectedly destroyed" and Electron's main process crashes. That is an artefact of the test method, not an Axis path, and the evidence does not use it.
- **Screens:** the X root window read with `XGetImage` and written as PNG; the renderer state read over CDP: banner text, button, chips, outcome line and active element.
- **A secure safeStorage backend:** without one Electron reports `basic_text`, the audit anchor is `anchor_unreachable` and the host is degraded. A degraded host writes nothing, so every project message is `E_UNAVAILABLE` (`projects/control.ts`) and main's dialogs never open. That is correct behaviour, and the first run showed it: Add answered "The Axis service is not available. Nothing changed." A throwaway GNOME keyring makes the backend secure:
  - `dbus-run-session` holds an unlocked keyring whose `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` are under the rig, never the user's keyring.
  - Electron runs with `--password-store=gnome-libsecret`.
  - The keyring daemon and the session are stopped by their saved PIDs afterwards.

  The packages come from the official Ubuntu archive, suite `resolute` (`main`), the suite of the existing sysroot. They were fetched over HTTPS, extracted (not installed) into the builder's private tool directory, and checked three ways:
  - the `InRelease` signature: Good, "Ubuntu Archive Automatic Signing Key (2018)", RSA key `F6ECB3762474EDA9D21B7022871920D1991BC93C`;
  - the `main` `Packages.xz` SHA256 against it: `ed9ac41cb263efaecc5a06a0742dc56570e2fb5ff94c4f2e4b2fbdcddd73cf24`;
  - each package's SHA256 against the index:

| Package | Version | SHA256 |
|---|---|---|
| `gnome-keyring` | 50.0-1 | `8b5acd08a0857f8622087271bcfd5c72e8585fa0e02d1a56706b0d1c6bf66a34` |
| `libgck-1-0` | 3.41.2-6 | `a8dd84aa3583486942728f2266a1d3b9d1fa5b2799b830bfe8e884d5da93cfa1` |
| `libgcr-base-3-1` | 3.41.2-6 | `9513409787d4dc4242943c0d8a4fb2de12ff21c281612007402bd0d731aa9b64` |
| `libsecret-1-0` | 0.21.7-2build1 | `5cf26cf395af46280fda3fca0b36abe5122588afb36b839a69cbca21b89ed362` |

The other dependencies (GLib, p11-kit, libgcrypt, libcap-ng, D-Bus) come from the host.

## Results

Every press below is real X input on main's own dialog. "Focus" is the renderer's active element after the outcome.

| Step | What happened | Outcome line | Focus |
|---|---|---|---|
| Connected, no projects (S3 fix) | chip "+ changes-repo: not added to Axis"; banner "This folder is not an Axis project yet." with Add Project… | none | the dashboard row (the button never takes it on load) |
| No click for 10 s | nothing changed; main logged no project action | none | unchanged |
| Add Project… (click) | dialog "Add this repository to Axis?": the folder, "Remote: none", Cancel and Add read-only (no "Add and trust": the folder was not Workspace-Trusted) | "Waiting for confirmation in the Axis dialog." | |
| Escape | dialog gone, nothing registered | "Cancelled. Nothing changed." | the button |
| Add again within 60 s | no dialog (per-folder cooldown) | "Another project action is in progress, or one was just cancelled. Try again in a minute." | the button |
| Enter on the dialog | Cancel is the default: nothing registered | "Cancelled. Nothing changed." | the button |
| Close (`WM_DELETE_WINDOW`) | nothing registered | "Cancelled. Nothing changed." | the button |
| Add read-only (click) | registered read only; chip "⊘ changes-repo: read only" from the daemon | "Added the repository read only." | the button |
| Trust Project to Run… without Workspace Trust | no dialog | "That cannot be done for this folder now." | |
| Workspace Trust granted in Code OSS's own prompt, then Trust Project to Run… | dialog "Trust this repository to run?": the folder, the remote, Cancel and Trust to run | "Waiting for confirmation …" | |
| Enter on it | Cancel is the default: still read only | "Cancelled. Nothing changed." | |
| Trust to run (click, after the cooldown) | chip "trusted" from the daemon | "The repository is trusted to run." | |
| Stop Trusting Project (no dialog, by design) | chip "read only" | "The repository is read only now. Its runs were stopped." | the row focused before |
| Fresh folder: Add, then Add read-only (S4 `status`) | the banner flips from "not an Axis project yet" + Add to "This folder is read only: …" + Trust to Run… | "Added the repository read only." | the button |

## Findings, and where they went

- **S3:** a connected service holding no project was shown as "not connected", with no Add button. Fixed in S3 (`trustSource`: offline, unregistered or daemon).
- **S4:** the banner found the window's project through a local-checkout row. The daemon's worktree rows do not include the main checkout, so after an add the banner still offered Add. Fixed by main's `status` read (§4.2 "As built (S4)").
- **S4:** `dir=auto` on a whole chip sentence let a right-to-left name flip the sentence, and the CSS ellipsis cut the name's start. Fixed by isolating only the name (U+2068 … U+2069), removing control characters and cutting at 40.
- **S4:** the 🔒 glyph rendered as an empty box without an emoji font. Replaced by ⊘.
- **Open (PV-E0 F2):** a degraded host counts as connected, so before `status` existed the banner offered Add, which every write refuses. With `status` a degraded host answers `unavailable` and the banner offers nothing. The degraded and failed notices themselves still need main's supervisor state in the renderer (a separate ticket).

The screenshots (`01` to `25`) are kept with the reviewers' evidence, not in the repository.
