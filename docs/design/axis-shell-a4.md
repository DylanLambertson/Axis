# Shell A4: approval cards in the Agent view

Companion to `axis-shell-a2.md` (A2 read `axis.approvals/1.pending` for a count), `axis-shell-a3.md` and ADR 0003 D4 (challenges, native confirmation). A4 shows each pending challenge as a card below the workspace list. It adds behaviour and structure only: no colours, spacing or other visual design (the UI direction is not chosen), and no change to any daemon contract.

## What a card is

A card is display of a challenge the daemon issued. The listing (`listedChallengeSchema` in `@axis/protocol`) carries: challenge id, digest, contract, method, tier, a redacted one-line `targetSummary` (at most 192 characters), `nativeConfirmationRequired` and `expiresAt` (epoch milliseconds). The card shows the request (`contract.method`), the target summary, the tier and the expiry time.

Not on the card, because the merged contract does not carry them: the workspace the request belongs to, and the received-sources or hop list. The listing is per window and a strict schema, so the reader refuses any extra field. Showing them needs an additive field in `axis.approvals/1` first; that is a daemon ticket, and the reader and the card then change together.

## Who answers what

Every card has Deny and Approve (Deny first). What Approve means depends on the tier, as the daemon works (ADR 0003 D4, `ChallengeManager`):

| Card | Approve in the renderer | What settles it |
|---|---|---|
| tier 0 to 3, `nativeConfirmationRequired` false | `axis.approvals/1.resolve(approve)` | the daemon, at once |
| tier 4 or 5, or `nativeConfirmationRequired` true | the first step only: `resolve(approve)` moves the challenge to awaiting the native confirmation. The button reads "Approve, then confirm in the dialog" and the card says a native confirmation follows | the native dialog that main shows. The daemon refuses a native challenge without it, and the dialog's answer is held until the user has approved |

The renderer never answers the native dialog and has no path to it: the dialog is the gate a compromised renderer cannot pass. Either signal (tier of 4 or more, or the daemon flag) makes a card native (`needsNativeConfirmation`). A native card answered `approved` with `nativeRequired: true` shows "waiting for the native confirmation"; a `nativeRequired: true` reply on a card that has no native step is refused as `invalid_reply`.

A script that runs in the renderer can call the client's `request('axis.approvals', 'resolve', ...)` itself, so the gesture rules below keep accidents and agent-authored text from resolving a card but do not stop that; for tiers 0 to 3 the daemon's own checks (user actor, digest, expiry, single use) are what remain, and for tier 4 and 5 the native dialog is.

## The trusted gesture

`AxisApprovalController.decide` (`services/approvals/common/axisApprovals.ts`) sends nothing unless, in this order:

1. The event is a trusted click: `event.isTrusted === true` (script-dispatched events and `element.click()` have `false`) and `event.type === 'click'`. Keyboard use works because Enter and Space on a focused button produce a trusted click.
2. The event target is that card's own button (identity), the card contains the button, `document.activeElement` is inside the card, and it is not inside the composer (`COMPOSER_SELECTOR`, `.axis-composer`; a future composer root must carry that class) or any other agent-facing input. The view builds this scope with `scopeFor` only, so the checks and the values they are given are testable.
3. The card is still listed with the digest the user was shown. A card that left the list, or came back with another digest, is `stale`, and the list is read again.
4. The card has been in place for the guard time (below).
5. The card has not expired against the injected clock (the expiry instant itself is expired).
6. The card has not been answered already (it stays `settled` until it leaves the listing, so key repeat or a second click sends nothing), and no answer for it is in flight.

The request is `{ challengeId, decision, digest }` and nothing else: identity comes from the port, never from the renderer. The reply must be exactly `{ challengeId, state, nativeRequired }`, for the same challenge, and the state must answer the question asked (an `approved` reply to a Deny is `invalid_reply`). The list is read again after every answer.

There is no command, keybinding or menu item that answers an approval, and the composer has no path to the controller: the only caller of `decideApproval` is the click handler on a card button (`test/code-oss/approval-cards-source.test.mjs`).

## Layout: a click must land on the card the user aimed at

An agent can add a challenge (a new request) or remove one (dropping its connection), so a card can appear or slide under the pointer. Three rules:

- **Stable cards.** `layout()` keeps shown cards where they are and puts new ones last, whatever order the daemon lists. The view keeps a card's element while its challenge id and digest stay listed, and never reorders them.
- **Out of the way.** The region sits below the workspace list, so a new card never moves a row.
- **Guard time.** A card that is new, has moved (a gap closed before it) or came back with another digest cannot be answered for 500 ms (`APPROVAL_GUARD_MS`, monotonic clock, injected). A click in that time is refused (`too-soon`) and its buttons are disabled meanwhile; a card that was never laid out is refused the same way. Buttons are also disabled once a card has expired (one timer, re-armed for the next boundary).

## Text

Everything on a card is set with `textContent`; the view has no HTML sink. The target summary also passes `cleanDisplayText` in the reader (control, bidi and zero-width characters become U+FFFD), so agent-authored markup shows as literal characters. The outcome line is fixed, localized text per closed outcome, prefixed with the request it answers; a daemon message, code or path is never shown. It is one persistent `role="status"` region. At most 20 cards are drawn; the rest are counted in a note.

## Tests

Overlay mocha (common): the reader (exact shape, every bound, cleaned text, duplicate ids), the controller (trusted click, a synthetic event of every shape, wrong target, focus outside the card, focus in the composer, native cards answered with one `resolve` and "waiting for native confirmation", an untrusted event on a native card, stale id and digest, expiry boundary, guard time and moves, stable order, settled, in-flight, reply mismatches, call failures, markup in the summary) and `scopeFor`. Node (`test/code-oss/approval-cards-source.test.mjs`): the view uses no HTML sink and no script-made event, builds its scope with one `scopeFor(cardElement, button, ...)` call and reads no `activeElement` or `body` itself, draws from `layoutApprovals`, passes the DOM event itself, sits below the list; no other file requests a decision. The DOM view itself needs a workbench and has no unit test, as the dashboard has none (A2).
