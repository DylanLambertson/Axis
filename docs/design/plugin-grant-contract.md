# The plugin grant contract (ticket PV-K2, grant part)

- **Status:** design only, not built. Date 2026-11-26.
- **Scope:** who may write `plugin_enablement` and `plugin_grants` (journal v16, PV-K1b), through which calls, what each write is
  bound to, and what a revoke or a disable ends.
- **Not in scope:** install, update, signatures and extraction are the rest of PV-K2 and follow ADR 0008 decisions 7 and 8. They
  create the plugin's `plugin_enablement` row and propose grants. This note covers only the calls that change a grant or the
  switch.
- **Sources:** ADR 0008 decisions 4, 6 and 8 and the amendment "how the main-built dialog is reached" (2026-11-22);
  `docs/design/plugin-grants.md`; `docs/design/plugin-run-start.md`.

## 1. Precondition (owner delegation, 2026-11-26)

PV-K2's grant calls must not be enabled or merged until the product's own shell has the approval card. That card reads
`axis.approvals/1.pending` and `axis.approvals/1.detail`, and shows the full escaped prompt, the project, workspace, mode,
provider and model of a plugin's run start.

Until then no plugin can hold `runs.start`, and that is the only thing keeping PV-K1e-b inert.

## 2. The calls

A new contract, `axis.plugins/1`. Every method is user-only:
- a `userRule` row;
- never a web client (outside `WEB_ALLOWED`);
- never a plugin (`axis.plugins/` is added to `PLUGIN_DENY_CONTRACTS`);
- never a worker;
- and the handler refuses every actor but the user with `E_NOT_FOUND`, as every handler does.

| Method | What it does | Tier | Why that tier |
|---|---|---|---|
| `list` | the plugins of one project, each with its switch, generation and granted permissions | 0 | read |
| `grant` | adds one permission of the closed set to a plugin in a project | **4** | an increase (decision 8): a daemon challenge plus `native.confirm`, in a dialog main draws |
| `enable` | turns a plugin on in a project | **4** | an increase (decision 8) |
| `revoke` | removes one permission | 2 | a decrease applies at once (decision 8). The one risk is a hostile renderer revoking a grant, which is a denial of service the user can undo |
| `disable` | turns a plugin off in a project | 2 | a decrease, as above |

One grant per call. A dialog that offers several permissions (the install dialog) confirms each one as its own row, or confirms
one `grant` challenge whose digest covers the whole set. The install design decides which.

## 3. What a grant binds

- **The request.** The challenge's digest covers the plugin id, the project, the permission, the generation of the plugin's row
  now, and the plugin's current switch and permission set. A revoke, a disable or another grant between the dialog and the
  confirmation changes the content, so the confirmation is refused (`E_CONFLICT`, "the content changed").
- **The native dialog line** (APR-2). It is built only from values the daemon derives. Never from the manifest's display name or
  description: the plugin wrote those, and they could say "safe to approve". The line is the plugin id, the permission's plain
  wording from a fixed table, and the project's display name, which the user chose.
  - The `runs.start` line reads "can ask to start AI runs in <project>; each start asks you first and runs as untrusted".
  - The dangerous-combination lines (`PLUGIN_DANGEROUS_COMBINATIONS`, PV-K1b) are computed over the permissions after the grant.
  - A line too long for the dialog's 80 code units loses the project name first (the pages rule, `pages/confirm.ts`).
- **The write.** `journal.plugins.grant`, already built, runs inside the approved action under the project mutex. The grant
  inserts once: a permission already granted gives `E_CONFLICT` with reason `already_granted`, and nothing is written twice.
  The generation does not change on a grant or an enable (the v16 trigger rule).

## 4. Revoke and disable

- **The generation grows by one** on every revoke and every disable (v16 triggers). Nothing else moves it.
- **Open plugin challenges end at once.** The `axis.plugins/1` handler calls a new `approvals.endPlugin(pluginId, projectId)`
  after the write. It withdraws every open challenge of that plugin in that project, as its requester, which is the a2-1b
  binding failure path. Today those challenges are refused only lazily, when the next call or detail read touches them; this
  takes them out of the user's listing at once.
- **An approval already given cannot be spent.** The binding's `valid()` and the content digest both carry the generation
  (a2-1b, K1e-b), so a spend after the revoke is refused even if `endPlugin` were missed.
- **Runs already started keep running.** The user approved each one, it is tainted, and every side effect asks again. Revoking
  `runs.start` does not cancel them. *Owner question:* should a disable (as opposed to a revoke) cancel the plugin's live runs?
  The recommendation is no, with the run's card naming the plugin so the user can cancel it.
- **The plugin's view stays open.** The policy refuses each later call. A revoke does not close the connection: closing the view
  is the shell's choice.
- **A disable keeps the grants.** Enabling again needs a tier-4 `enable`, never a new `grant` (`plugin-grants.md` §1).

## 5. Limits and audit

- At most 64 plugins per project (v16) and at most 8 permissions per plugin (the closed set). `grant` checks the set; the
  journal's CHECK refuses anything else.
- Every write appends `journal.plugin.record` (ids, a fixed field and the permission only), as PV-K1b built it. The tier-4
  calls are also audited by the challenge manager (`tier4.challenge`, `tier4.execute`).

## 6. Tests and mutants for the ticket

**Tests:**
- every method refused for a plugin, a web client and a worker;
- `grant` and `enable` need the native confirmation: a renderer-only resolve does not run them;
- the dialog line uses no manifest text (a manifest name of "SAFE TO APPROVE" never appears);
- a concurrent revoke between the dialog and the confirmation refuses the grant;
- `already_granted`;
- revoke and disable each bump the generation by one, and end the plugin's open challenges at once: they are gone from the
  listing, and a later detail read and spend are refused;
- a run started before the revoke keeps running;
- disable then enable keeps the grants and does not reset the hourly counter (v17).

**Mutants:**
- `grant` at tier 3;
- the manifest name in the dialog line;
- the generation left out of the digest;
- `endPlugin` not called;
- revoke allowed to a plugin;
- `axis.plugins/` missing from the deny list.

## 7. Open for the owner

- **Tier 4 for plugin run starts:** PV-K1e-T4, still open.
- **Disable and live runs:** whether a disable cancels the plugin's live runs (section 4).
- **Batch grants at install:** one challenge for a batch of grants, or one per grant (section 2).
