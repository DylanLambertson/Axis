# Runs started by a plugin (ticket PV-K1e)

- **Status:** PV-K1e-a built (service level, inert). PV-K1e-a2 (approval routing) and PV-K1e-b (the handler) are not built.
- **Date:** 2026-11-22. Implements ADR 0008 decision 6, rules 1 and 2, and criterion 14 in three slices.

## 1. PV-K1e-a: the service (built)

- `ComposerStartInput.initiator` is `{ kind: "user" }` or `{ kind: "plugin", pluginId, generation }`. The handler builds it from the
  attested identity only; the wire schema of `axis.runs/1.start` has no such field, so a request cannot name one (tested). Absent
  means the user, and a user start is unchanged.
- A plugin start is recorded with `createdBy` `plugin:<id>` (the journal's actor rule is now the audit log's `ACTOR_PATTERN`); no
  transition of the run is the user's.
- **Taint first.** The run is tainted with source `plugin_output` (IAC-T source 6) inside the journal transaction that creates it,
  before its activity opens and before any model call. The mark and its `message.taint` audit row go to the journal's own
  database: if either fails, nothing is created and the start is refused (`taint_unrecorded`). Without the host's
  `taintAtStart`, a plugin start is refused (`plugin_starts_unavailable`). Source 6 stays PV-K4's for every other plugin output.
- **Inert.** The `axis.runs/1` handler still refuses every actor but the user (`E_NOT_FOUND`), so nothing reaches this from the wire.

## 2. PV-K1e-a2: the approval card (design note first, not built)

A tier-3 challenge is bound to the requesting connection's window today, so a plugin start's challenge would sit on `p<n>`, which
the plugin cannot resolve and the user cannot see, and a listed challenge carries only a 192-character summary. PV-K1e-a2 sends the
challenge to the attested host window, adds a bounded, daemon-escaped `detail` with the full prompt, and amends ADR 0003 D4.

**Tier 3 is resolved in the renderer.** Native confirmation exists only at tier 4, so the protection of a plugin start is the taint,
the full prompt on the card and an approval for each side effect of the run, not a native dialog.

## 3. PV-K1e-b: the handler (waits for a2)

`forcedScope` in the same PR, the project trust gate through the host window, the grant's generation bound into the challenge, the
OI-2/OI-10 bounds, and `axis.review/1.diff`'s `acknowledged` still refused for plugins. CLI starts never.

## 4. Open for the owner

Whether a plugin run start should be tier 4 (cost, side effects): see the tickets table, row PV-K1e-T4.

## 5. What K1e-a does not enforce (review F-notes)

- **A stale grant generation is not refused here.** K1e-a checks that `generation` is a positive integer and that the plugin id has the attested shape; it does not compare the generation with the stored grant. K1e-b's handler reads the K1b grant and binds the generation into the challenge (a2 adds the host-window binding), so a disable, revoke or generation change refuses the start there. Nobody should assume the service checks it.
- **`initiator` is required** in `ComposerStartInput`: a caller that forgets it does not compile, so a missing initiator can never mean "the user" by default. Today the runs handler passes `{ kind: "user" }`; K1e-b builds a plugin initiator from the attested identity only.
- **The initiator is read once** into locals before any check, and the taint hook must finish inside the creation: a missing hook or a hook that returns a promise refuses the start with nothing created.
