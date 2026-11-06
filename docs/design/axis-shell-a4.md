# Shell A4: approval cards in the Agent view

Companion to `axis-shell-a2.md` (A2 read `axis.approvals/1.pending` for a count), `axis-shell-a3.md` and ADR 0003 D4 (challenges, native confirmation). A4 shows each pending challenge as a card above the workspace list. It adds behaviour and structure only: no colours, spacing or other visual design (the UI direction is not chosen), and no change to any daemon contract.

## What a card is

A card is display of a challenge the daemon issued. The listing (`listedChallengeSchema` in `@axis/protocol`) carries: challenge id, digest, contract, method, tier, a redacted one-line `targetSummary` (at most 192 characters), `nativeConfirmationRequired` and `expiresAt` (epoch milliseconds). The card shows the request (`contract.method`), the target summary, the tier and the expiry time.

Not on the card, because the merged contract does not carry them: the workspace the request belongs to, and the received-sources or hop list. The listing is per window and a strict schema, so the reader refuses any extra field. Showing them needs an additive field in `axis.approvals/1` first; that is a daemon ticket, and the reader and the card then change together.

## Who answers what

| Card | Buttons | Answered by |
|---|---|---|
| tier 0 to 3, `nativeConfirmationRequired` false | Approve, Deny | the user, in the renderer, through `axis.approvals/1.resolve` |
| tier 4 or 5, or `nativeConfirmationRequired` true | none | the native dialog, which main opens (ADR 0003 D4). The card says so |

Both signals must agree before a card is answerable here (`isRendererResolvable`): a daemon that marks a low tier native, or a tier 4 card marked not native, gets no buttons. The controller refuses both Approve and Deny for such a card even if a caller asks (`native-only`), so the rule does not rest on the view hiding a button.

## The trusted gesture

`AxisApprovalController.decide` (`services/approvals/common/axisApprovals.ts`) sends nothing unless, in this order:

1. The event is a trusted click: `event.isTrusted === true` (script-dispatched events and `element.click()` have `false`) and `event.type === 'click'`. Keyboard use works because Enter and Space on a focused button produce a trusted click.
2. The event target is that card's own button (identity), the card contains the button, `document.activeElement` is inside the card, and it is not inside the composer (`.axis-composer`) or any other agent-facing input.
3. The card is still listed with the digest the user was shown. A card that left the list, or came back with another digest, is `stale`, and the list is read again.
4. The card has not expired against the injected clock (the expiry instant itself is expired).
5. The card is answerable in the renderer (above).
6. No answer for that challenge is in flight.

The request is `{ challengeId, decision, digest }` and nothing else: identity comes from the port, never from the renderer. The reply must be exactly `{ challengeId, state, nativeRequired }`, for the same challenge, and the state must answer the question asked (an `approved` reply to a Deny is `invalid_reply`). The list is read again after every answer. The daemon still checks everything itself (user actor, digest, expiry, single use); these rules only keep the renderer from sending what it should not.

There is no command, keybinding or menu item that answers an approval, and the composer has no path to the controller: the only caller of `decideApproval` is the click handler on a card button (`test/code-oss/approval-cards-source.test.mjs`).

## Text

Everything on a card is set with `textContent`; the view has no HTML sink. The target summary also passes `cleanDisplayText` in the reader (control, bidi and zero-width characters become U+FFFD), so agent-authored markup shows as literal characters. The outcome line is fixed, localized text per closed outcome (approved, denied, waiting for the native dialog, expired, changed, not a user click, answered natively, busy, could not be sent); a daemon message, code or path is never shown. It is one persistent `role="status"` region. At most 20 cards are drawn; the rest are counted in a note.

## Tests

Overlay mocha (common): the reader (exact shape, every bound, cleaned text, duplicate ids), the controller (trusted click, a synthetic event of every shape, wrong target, focus outside the card, focus in the composer, tier 4 and 5 and the native flag both ways, stale id and stale digest, expiry boundary, in-flight, reply mismatches, call failures, markup in the summary). Node (`test/code-oss/approval-cards-source.test.mjs`): the view uses no HTML sink and no script-made event, listens only for `click` on the card button and passes the DOM event itself; no other file requests a decision. The DOM view itself needs a workbench and has no unit test, as the dashboard has none (A2).
