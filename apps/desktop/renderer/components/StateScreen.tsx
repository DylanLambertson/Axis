// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The screens a page shows instead of its content (OS-6): loading, disconnected, failed, unreadable, empty and
// refused. Every one says in words what is true and what to do; none shows sample data. Loading is a static skeleton
// (no spinner, no pulse: tokens.md section 5 has no loops), announced once as busy.

import { useId, type ReactNode } from "react";
import { BRAND } from "@axis/ui";
import { Glyph } from "./Glyph.js";

/** An action is either live (it has `onClick`) or off with the reason shown beside it: never off and unexplained. */
export type StateAction =
  | { readonly label: string; readonly onClick: () => void; readonly disabledReason?: undefined }
  | { readonly label: string; readonly onClick?: undefined; readonly disabledReason: string };

/** Shown when a caller passes neither (outside the types): the button is still never off without a word. */
const UNEXPLAINED = "This is not available yet.";

function Action({ action }: { readonly action: StateAction }) {
  const why = useId();
  const onClick = action.disabledReason === undefined ? action.onClick : undefined;
  const reason = onClick === undefined ? (action.disabledReason ?? UNEXPLAINED) : undefined;
  return (
    <div className="axis-state__action">
      <button type="button" className="axis-btn axis-btn--primary" disabled={onClick === undefined} onClick={onClick} aria-describedby={reason === undefined ? undefined : why}>
        {action.label}
      </button>
      {reason !== undefined && (
        <p id={why} className="axis-state__why">
          {reason}
        </p>
      )}
    </div>
  );
}

function Shell({ kind, title, children }: { readonly kind: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <section className={`axis-state axis-state--${kind}`} aria-labelledby={`axis-state-${kind}`}>
      <h2 id={`axis-state-${kind}`} className="axis-state__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function LoadingState({ what }: { readonly what: string }) {
  return (
    <section className="axis-state axis-state--loading" aria-busy="true" aria-label={`Loading ${what}`}>
      <div className="axis-skeleton" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="axis-skeleton__row" />
        ))}
      </div>
    </section>
  );
}

export function EmptyState({ title, body, action }: { readonly title: string; readonly body: string; readonly action?: StateAction }) {
  return (
    <Shell kind="empty" title={title}>
      <p className="axis-state__body">{body}</p>
      {action && <Action action={action} />}
    </Shell>
  );
}

/** The daemon is not connected or stopped: nothing is shown as current, and the notice above says why. */
export function ServiceState({ kind }: { readonly kind: "disconnected" | "failed" | "unreadable" }) {
  const title =
    kind === "failed" ? `The ${BRAND.productName} service stopped` : kind === "unreadable" ? `Nothing could be read from the ${BRAND.productName} service yet` : `Not connected to the ${BRAND.productName} service`;
  const body =
    kind === "failed"
      ? "Nothing here is current. The notice above says what to do."
      : kind === "unreadable"
        ? "The service is connected but did not answer. It is asked again on the next refresh."
        : "Workspaces, agent runs, run trust and approvals appear once it connects.";
  return (
    <Shell kind={kind} title={title}>
      <p className="axis-state__body">{body}</p>
    </Shell>
  );
}

/** A refusal: the action was not done. The sentence is a closed one (`refusalText`), never daemon text. */
export function RefusalState({ title, sentence, action }: { readonly title: string; readonly sentence: string; readonly action?: StateAction }) {
  return (
    <section className="axis-state axis-state--refused" role="alert" aria-labelledby="axis-state-refused">
      <h2 id="axis-state-refused" className="axis-state__title">
        <Glyph kind="bad" /> {title}
      </h2>
      <p className="axis-state__body">{sentence}</p>
      {action && <Action action={action} />}
    </section>
  );
}
