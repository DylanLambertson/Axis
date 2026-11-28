// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The pending decision card (directions.md section 3.5 item 4, rule 9; OS-11 wires it to approvals). It is the one
// lifted surface. Focus arrives on Deny. "Approve once" shows its shortcut, and Mod+Enter approves only through
// `approvalShortcutAllowed`: a real key press on the card with the focus inside it, never from the composer or an
// editor. Escape moves focus to Deny. The card decides nothing itself: it calls `onApprove` / `onDeny`, and the answer
// path behind them checks the digest, the guard time and expiry exactly as for a click.

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { approvalShortcutAllowed, approvalShortcutAria, approvalShortcutKeys } from "@axis/shell-core";
import { Glyph } from "./Glyph.js";
import { Keycaps } from "./Keycaps.js";

export interface DecisionField {
  readonly term: string;
  readonly value: string;
}

export interface DecisionCardProps {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly DecisionField[];
  readonly isMac: boolean;
  /** Off while the daemon is degraded or the answer is in flight; the reason is shown on the card. */
  readonly disabledReason?: string;
  readonly focusOnMount?: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}

/**
 * True when `node` is inside an element matching `selector`. For the event target the composed path is walked, since
 * `closest()` stops at a shadow root; for another node (the focused element) `closest()` is used.
 */
function inside(node: unknown, selector: string, target: EventTarget | null, path: readonly EventTarget[]): boolean {
  if (node === target) return path.some((n) => n instanceof Element && n.matches(selector));
  return node instanceof Element && node.closest(selector) !== null;
}

export function DecisionCard(props: DecisionCardProps) {
  const card = useRef<HTMLElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const off = props.disabledReason !== undefined;
  const why = useId();

  useEffect(() => {
    if (props.focusOnMount) deny.current?.focus();
  }, [props.focusOnMount]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const native = event.nativeEvent;
    if (event.key === "Escape") {
      deny.current?.focus();
      event.preventDefault();
      return;
    }
    const element = card.current;
    if (off || element === null) return;
    const path = native.composedPath();
    const active = element.ownerDocument.activeElement;
    const scope = {
      card: { contains: (n: unknown) => n instanceof Node && element.contains(n) },
      activeElement: active,
      isInComposer: (n: unknown) => inside(n, "[data-axis-composer]", native.target, path),
      isInEditor: (n: unknown) => inside(n, ".monaco-editor", native.target, path),
    };
    const allowed = approvalShortcutAllowed(native, scope, props.isMac);
    if (allowed) {
      event.preventDefault();
      props.onApprove();
    }
  }

  const titleId = `axis-decision-${props.id}`;
  return (
    <section ref={card} className="axis-decision" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="axis-decision__head">
        <Glyph kind="wait" />
        <h3 id={titleId}>{props.title}</h3>
        <span className="axis-tag axis-tag--warn">Waiting for you</span>
      </header>
      <dl className="axis-decision__fields">
        {props.fields.map((f) => (
          <div key={f.term} className="axis-decision__field">
            <dt>{f.term}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {off && (
        <p id={why} className="axis-decision__why">
          {props.disabledReason}
        </p>
      )}
      <div className="axis-decision__actions">
        <button type="button" className="axis-btn axis-btn--primary" disabled={off} aria-describedby={off ? why : undefined} aria-keyshortcuts={approvalShortcutAria(props.isMac)} onClick={props.onApprove}>
          Approve once <Keycaps keys={approvalShortcutKeys(props.isMac)} />
        </button>
        <button ref={deny} type="button" className="axis-btn axis-btn--secondary" onClick={props.onDeny}>
          Deny
        </button>
      </div>
    </section>
  );
}
