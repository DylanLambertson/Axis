// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The renderer's root (OS-6): the frame, the route from the URL hash and the screen state. The daemon status stays
// `down` until the main seam (OS-3) connects the renderer to the daemon; secure storage stays `unknown` until main
// reports it (OS-27). Neither is guessed.

import { useEffect, useMemo, useState } from "react";
import { screenStateOf, type AxisDaemonStatus, type AxisSecureStorage, type IAxisSnapshot } from "@axis/shell-core";
import { Frame } from "./frame/Frame.js";
import { Gallery } from "./frame/Gallery.js";
import { RouteScreen } from "./frame/Screens.js";
import { hashOf, routeOf, routeTitle, type RouteId } from "./frame/routes.js";

export interface AppProps {
  readonly initialHash: string;
  readonly isMac: boolean;
  readonly status?: AxisDaemonStatus;
  readonly snapshot?: IAxisSnapshot;
  readonly secureStorage?: AxisSecureStorage;
}

const ACTIVITY: Readonly<Record<string, string>> = {
  loading: "Connecting",
  disconnected: "Not connected",
  failed: "Service stopped",
  unreadable: "Not answering",
  empty: "Connected",
  ready: "Connected",
};

export function App(props: AppProps) {
  const [route, setRoute] = useState<RouteId>(routeOf(props.initialHash));
  const screen = useMemo(
    () => screenStateOf({ status: props.status ?? { kind: "down" }, snapshot: props.snapshot, secureStorage: props.secureStorage ?? "unknown" }),
    [props.status, props.snapshot, props.secureStorage],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => setRoute(routeOf(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const title = route === "home" ? "Project home" : routeTitle(route);
  const navigate = (next: RouteId) => {
    if (typeof window !== "undefined") window.location.hash = hashOf(next);
    setRoute(next);
  };

  return (
    <Frame route={route} title={title} activity={ACTIVITY[screen.kind]!} readOnly={screen.readOnly} notices={route === "states" ? [] : screen.notices} announcement={title} onNavigate={navigate}>
      {route === "states" ? <Gallery isMac={props.isMac} /> : <RouteScreen route={route} screen={screen} />}
    </Frame>
  );
}
