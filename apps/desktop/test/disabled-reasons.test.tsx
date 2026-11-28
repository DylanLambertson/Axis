// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-6 review N2: a disabled button always says why, and the reason describes the button (aria-describedby).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState, RefusalState, type StateAction } from "../renderer/components/StateScreen.js";
import { TerminalPane } from "../renderer/components/TerminalPane.js";

const described = (html: string, label: string) => new RegExp(`disabled="" aria-describedby="([^"]+)">${label}</button><p id="\\1"[^>]*>([^<]+)</p>`).exec(html)?.[2];

test("a state action is live with onClick, or off with its reason; an input outside the types still explains itself", () => {
  const live = renderToStaticMarkup(<EmptyState title="t" body="b" action={{ label: "Add", onClick: () => {} }} />);
  assert.match(live, /<button type="button" class="axis-btn axis-btn--primary">Add<\/button><\/div>/, "no reason, not disabled");
  assert.equal(described(renderToStaticMarkup(<EmptyState title="t" body="b" action={{ label: "Add", disabledReason: "Not while read only." }} />), "Add"), "Not while read only.");
  const bare = { label: "Add" } as unknown as StateAction;
  assert.equal(described(renderToStaticMarkup(<EmptyState title="t" body="b" action={bare} />), "Add"), "This is not available yet.");
  const both = { label: "Retry", onClick: () => {}, disabledReason: "Not now." } as unknown as StateAction;
  assert.equal(described(renderToStaticMarkup(<RefusalState title="t" sentence="s" action={both} />), "Retry"), "Not now.", "a reason wins over a callback");
});

test("an exited terminal without a restart says why the button is off", () => {
  const html = renderToStaticMarkup(<TerminalPane state={{ kind: "exited", code: 1 }} />);
  assert.equal(described(html, "Restart terminal"), "A restart is not available here yet.");
  const live = renderToStaticMarkup(<TerminalPane state={{ kind: "exited", code: 1 }} onRestart={() => {}} />);
  assert.match(live, /<button type="button" class="axis-btn axis-btn--secondary">Restart terminal<\/button>/);
  assert.doesNotMatch(live, /not available/);
});
