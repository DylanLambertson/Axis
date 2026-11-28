// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The frame and its state components, rendered to static markup: landmarks, the current page, the closed screen
// states, the decision card's shortcut badge and the review layout's DC-0 note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { emptySnapshot, screenStateOf, storageNotice, type AxisDaemonStatus, type IAxisSnapshot } from "@axis/shell-core";
import { BRAND } from "@axis/ui";
import { App } from "../renderer/App.js";
import { DecisionCard } from "../renderer/components/DecisionCard.js";
import { Notice } from "../renderer/components/Notice.js";
import { ReviewLayout } from "../renderer/components/ReviewLayout.js";
import { TerminalPane } from "../renderer/components/TerminalPane.js";
import { platformOf } from "../renderer/frame/keyboard.js";
import { RouteScreen } from "../renderer/frame/Screens.js";
import { hashOf, routeOf, routeTitle } from "../renderer/frame/routes.js";

const ROWS: IAxisSnapshot = { origin: "daemon", projects: [{ id: "p", name: "repo", trusted: true }], entries: [], approvals: [], notRegistered: false, truncatedProjects: false, staleError: undefined };
const count = (html: string, needle: string) => html.split(needle).length - 1;

test("routes: a closed set in the hash; anything else is home", () => {
  for (const r of ["home", "workspaces", "agents", "tasks", "states"] as const) assert.equal(routeOf(hashOf(r)), r);
  for (const h of ["", "#", "#/", "#/nope", "#workspaces", "#/workspaces/x", "#/workspaces?x=1", "#/constructor", "#/__proto__"]) assert.equal(routeOf(h), "home", h);
  assert.equal(routeTitle("states"), "State gallery");
});

test("the frame: banner, project navigation, main and one polite live region; only the current page is marked", () => {
  const html = renderToStaticMarkup(<App initialHash="#/workspaces" isMac={false} />);
  assert.match(html, /<header class="axis-top" data-region="top"/);
  assert.match(html, /<nav class="axis-rail" aria-label="Project" data-region="nav">/);
  assert.match(html, /<main class="axis-main" data-region="main" tabindex="-1" aria-labelledby="axis-page-title">/);
  assert.equal(count(html, 'aria-live="polite"'), 1);
  assert.equal(count(html, 'aria-current="page"'), 2, "the rail item and the breadcrumb");
  assert.match(html, /aria-current="page" tabindex="0"><span class="axis-rail__icon" aria-hidden="true">[^<]+<\/span><span>Workspaces<\/span>/);
  assert.equal(count(html, 'class="axis-rail__item" tabindex="-1"') + count(html, 'class="axis-rail__item" aria-current="page" tabindex="0"'), 4, "one tab stop in the rail");
  assert.ok(html.includes(`>${BRAND.productName}<`), "the brand comes from BRAND");
});

test("with no daemon connection yet the app says so, in the notice and the screen, and marks nothing current", () => {
  const html = renderToStaticMarkup(<App initialHash="" isMac={false} />);
  assert.match(html, /Not connected to the .+ service/);
  assert.match(html, /is not connected\. Worktrees, agent runs, run trust and approvals are not shown until it is\./);
  assert.match(html, />Not connected</);
  assert.doesNotMatch(html, /Read only/, "unknown storage is not shown as read only");
});

function screen(status: AxisDaemonStatus, snapshot: IAxisSnapshot | undefined, storage: "available" | "unavailable" = "available") {
  return renderToStaticMarkup(<RouteScreen route="workspaces" screen={screenStateOf({ status, snapshot, secureStorage: storage })} />);
}

test("each screen kind draws its own state, and a disabled action always says why", () => {
  assert.match(screen({ kind: "connecting" }, undefined), /aria-busy="true" aria-label="Loading workspaces"/);
  assert.match(screen({ kind: "down" }, undefined), /Not connected to the/);
  assert.match(screen({ kind: "failed", reason: "crash_loop" }, undefined), /service stopped/);
  assert.match(screen({ kind: "ready" }, emptySnapshot("E_TIMEOUT")), /Nothing could be read/);
  const empty = screen({ kind: "ready" }, { ...ROWS, notRegistered: true });
  assert.match(empty, /No projects yet/);
  assert.match(empty, /<button type="button" class="axis-btn axis-btn--primary" disabled="" aria-describedby="([^"]+)">Add project<\/button><p id="\1" class="axis-state__why">This is not part of this build yet\.<\/p>/, "the reason is shown and names the button");
  assert.match(screen({ kind: "ready" }, ROWS), /No workspaces yet/);
  assert.match(screen({ kind: "degraded" }, ROWS), /Nothing can be started while the service is read only\./);
  assert.match(screen({ kind: "ready" }, { ...ROWS, notRegistered: true }, "unavailable"), /Projects cannot be added while the service is read only\./);
  assert.doesNotMatch(screen({ kind: "connecting" }, undefined), /axis-skeleton__row[^>]*>[^<]/, "the skeleton holds no sample text");
});

test("notices: an error interrupts, a warning or note is polite, and the severity is spoken", () => {
  assert.match(renderToStaticMarkup(<Notice notice={{ severity: "error", text: "x" }} />), /role="alert".*Error: <\/span>x/);
  assert.match(renderToStaticMarkup(<Notice notice={storageNotice()} />), /role="status".*Warning: <\/span>No secure storage/);
});

test("the decision card: a labelled group, Approve once with its platform keycaps and aria-keyshortcuts, Deny always available", () => {
  const props = { id: "c1", title: "Run a command", fields: [{ term: "Action", value: "npm test" }], onApprove: () => {}, onDeny: () => {} };
  const other = renderToStaticMarkup(<DecisionCard {...props} isMac={false} />);
  assert.match(other, /role="group" aria-labelledby="axis-decision-c1"/);
  assert.match(other, /<h3 id="axis-decision-c1">Run a command<\/h3>/);
  assert.match(other, /aria-keyshortcuts="Control\+Enter">Approve once <span class="axis-keycaps" aria-hidden="true"><kbd class="axis-kbd">Ctrl<\/kbd><kbd class="axis-kbd">Enter<\/kbd>/);
  const mac = renderToStaticMarkup(<DecisionCard {...props} isMac={true} />);
  assert.match(mac, /aria-keyshortcuts="Meta\+Enter">Approve once .*<kbd class="axis-kbd">⌘<\/kbd><kbd class="axis-kbd">↩<\/kbd>/);
  const off = renderToStaticMarkup(<DecisionCard {...props} isMac={false} disabledReason="Approvals are not available." />);
  assert.match(off, /<p id="([^"]+)" class="axis-decision__why">Approvals are not available\.<\/p>.*disabled="" aria-describedby="\1" aria-keyshortcuts="Control\+Enter">Approve once/, "the reason describes Approve");
  assert.match(off, /<button type="button" class="axis-btn axis-btn--secondary">Deny<\/button>/, "Deny is never disabled");
});

test("the terminal pane: the not-yet state, connecting as busy, and an exit with its code and a restart", () => {
  assert.match(renderToStaticMarkup(<TerminalPane state={{ kind: "unavailable" }} />), /aria-label="Terminal" data-region="terminal".*not part of this build yet/);
  assert.match(renderToStaticMarkup(<TerminalPane state={{ kind: "connecting" }} />), /aria-busy="true"/);
  const exited = renderToStaticMarkup(<TerminalPane state={{ kind: "exited", code: 3 }} onRestart={() => {}} />);
  assert.match(exited, /Terminal process exited with code 3\./);
  assert.match(exited, /<button type="button" class="axis-btn axis-btn--secondary">Restart terminal<\/button>/);
});

test("the review layout: the DC-0 note, a listbox with one selected tab stop, and counts spoken in words", () => {
  const files = [{ id: "a", path: "src/a.ts", additions: 3, deletions: 1 }, { id: "b", path: "src/b.ts", additions: 0, deletions: 2 }];
  const html = renderToStaticMarkup(<ReviewLayout title="Changes" files={files} selectedId="b" onSelect={() => {}}><pre /></ReviewLayout>);
  assert.match(html, /so staged changes you made yourself are kept\./);
  assert.match(html, /role="listbox" aria-label="Changed files"/);
  assert.equal(count(html, 'aria-selected="true"'), 1);
  assert.match(html, /aria-selected="true" tabindex="0"><span class="axis-review__path">src\/b\.ts/);
  assert.match(html, /aria-label="3 added, 1 removed"/);
  const none = renderToStaticMarkup(<ReviewLayout title="Changes" files={files} selectedId={undefined} onSelect={() => {}}><pre /></ReviewLayout>);
  assert.equal(count(none, 'tabindex="0"'), 1, "with nothing selected the first row is the tab stop");
});

test("the state gallery renders every state without data and is not in the navigation", () => {
  const html = renderToStaticMarkup(<App initialHash="#/states" isMac={false} />);
  for (const t of ["Not connected to the", "No workspaces yet", "No secure storage", "HEAD or the branch moved", "index now matches the new commit.", "index was not updated. Another git program was using the index.", "Approve once", "Terminal process exited with code 1.", "staged changes you made yourself are kept"]) {
    assert.ok(html.includes(t), t);
  }
  assert.doesNotMatch(html, /<button[^>]*>.{0,80}State gallery/, "no rail entry");
});

test("platformOf: macOS from navigator.platform or the user agent", () => {
  assert.equal(platformOf({ platform: "MacIntel", userAgent: "" }), "mac");
  assert.equal(platformOf({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }), "mac");
  assert.equal(platformOf({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "other");
  assert.equal(platformOf({ platform: "Win32", userAgent: "" }), "other");
});
