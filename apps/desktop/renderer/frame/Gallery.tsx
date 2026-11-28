// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The state gallery (`#/states`): every state component of the frame with fixed example text, for design review and
// screenshots in both themes. It is not in the navigation and reads no data.

import { useState, type ReactNode } from "react";
import { commitDoneText, refusalText, storageNotice } from "@axis/shell-core";
import { DecisionCard } from "../components/DecisionCard.js";
import { Notice } from "../components/Notice.js";
import { ReviewLayout } from "../components/ReviewLayout.js";
import { EmptyState, LoadingState, RefusalState, ServiceState } from "../components/StateScreen.js";
import { TerminalPane } from "../components/TerminalPane.js";

const FILES = [
  { id: "f1", path: "src/billing/proration.ts", additions: 31, deletions: 9 },
  { id: "f2", path: "test/billing/proration.test.ts", additions: 54, deletions: 0 },
];

function Item({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <div className="axis-gallery__item">
      <p className="axis-label">{name}</p>
      {children}
    </div>
  );
}

export function Gallery({ isMac }: { readonly isMac: boolean }) {
  const [selected, setSelected] = useState("f1");
  return (
    <div className="axis-gallery">
      <Item name="Loading">
        <LoadingState what="workspaces" />
      </Item>
      <Item name="Disconnected">
        <ServiceState kind="disconnected" />
      </Item>
      <Item name="Failed">
        <ServiceState kind="failed" />
      </Item>
      <Item name="Empty">
        <EmptyState title="No workspaces yet" body="Create a workspace to begin running agents." action={{ label: "New workspace", onClick: () => {} }} />
      </Item>
      <Item name="No secure storage">
        <Notice notice={storageNotice()} />
      </Item>
      <Item name="Refused">
        <RefusalState title="The commit was refused" sentence={refusalText("axis.git/1.commit", "head_moved")} action={{ label: "Review again", onClick: () => {} }} />
      </Item>
      <Item name="Committed (DC-0)">
        <Notice notice={{ severity: "info", text: commitDoneText() }} />
      </Item>
      <Item name="Decision">
        <DecisionCard
          id="sample"
          title="Run a command in fix/proration-rounding"
          isMac={isMac}
          fields={[
            { term: "Action", value: "npm test -- billing" },
            { term: "Where", value: "fix/proration-rounding worktree" },
            { term: "Consequence", value: "Runs the test script; it can write inside the worktree." },
          ]}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </Item>
      <Item name="Terminal">
        <TerminalPane state={{ kind: "unavailable" }} region={false} />
        <TerminalPane state={{ kind: "exited", code: 1 }} onRestart={() => {}} region={false} />
      </Item>
      <Item name="Review layout">
        <ReviewLayout title="Changes in fix/proration-rounding" files={FILES} selectedId={selected} onSelect={setSelected}>
          <pre className="axis-diff">{"@@ -12,7 +12,9 @@\n-  return Math.round(amount * ratio);\n+  return roundHalfEven(amount * ratio, 2);"}</pre>
        </ReviewLayout>
      </Item>
    </div>
  );
}
