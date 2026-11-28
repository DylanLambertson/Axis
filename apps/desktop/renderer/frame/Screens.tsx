// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// What each route shows for the frame's screen state (OS-6). Until the main seam (OS-3) connects the daemon, every
// route is in a service state; once it does, a route shows its own empty state until its module (OS-8, OS-10, OS-12,
// OS-29) fills it.

import type { IAxisScreenState } from "@axis/shell-core";
import { EmptyState, LoadingState, ServiceState } from "../components/StateScreen.js";
import type { NavRouteId } from "./routes.js";

const EMPTY: Readonly<Record<NavRouteId, { readonly title: string; readonly body: string; readonly action: string }>> = {
  home: { title: "Nothing needs you", body: "Approvals, failed runs and quiet terminals appear here first.", action: "New workspace" },
  workspaces: { title: "No workspaces yet", body: "Create a workspace to begin running agents. Each one is its own branch and folder.", action: "New workspace" },
  agents: { title: "No agents yet", body: "Start an agent in a workspace. Composer agents and CLI agents are listed together.", action: "New agent" },
  tasks: { title: "No tasks yet", body: "Create a task to hand work to an agent.", action: "New task" },
};

const NOT_YET = "This is not part of this build yet.";

export function RouteScreen({ route, screen }: { readonly route: NavRouteId; readonly screen: IAxisScreenState }) {
  switch (screen.kind) {
    case "loading":
      return <LoadingState what={route} />;
    case "disconnected":
    case "failed":
    case "unreadable":
      return <ServiceState kind={screen.kind} />;
    case "empty":
      return (
        <EmptyState
          title="No projects yet"
          body="Add a repository to start. It is read only until you trust it to run, and its checkout is never changed."
          action={{ label: "Add project", disabledReason: screen.readOnly ? "Projects cannot be added while the service is read only." : NOT_YET }}
        />
      );
    case "ready": {
      const e = EMPTY[route];
      return <EmptyState title={e.title} body={e.body} action={{ label: e.action, disabledReason: screen.readOnly ? "Nothing can be started while the service is read only." : NOT_YET }} />;
    }
  }
}
