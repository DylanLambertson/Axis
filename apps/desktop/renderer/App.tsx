// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The renderer's root (OS-6): the frame, the route from the URL hash and the screen state. The daemon status stays
// `down` until the main seam (OS-3) connects the renderer to the daemon; secure storage stays `unknown` until main
// reports it (OS-27). Neither is guessed. The app registers the palette and navigation commands in the registry the
// key handler reads, opens the palette, and puts focus back afterwards: where it was, or the main region, never the body.

import { useEffect, useMemo, useRef, useState } from "react";
import { screenStateOf, type AxisDaemonStatus, type AxisSecureStorage, type IAxisSnapshot } from "@axis/shell-core";
import { CommandRegistry, chordAria, chordKeys, parseChord, type Platform } from "@axis/ui";
import { CommandPalette } from "./components/CommandPalette.js";
import { Frame } from "./frame/Frame.js";
import { Gallery } from "./frame/Gallery.js";
import { RouteScreen } from "./frame/Screens.js";
import { NAV_ROUTES, hashOf, routeOf, routeTitle, type RouteId } from "./frame/routes.js";

export interface AppProps {
  readonly initialHash: string;
  readonly isMac: boolean;
  readonly status?: AxisDaemonStatus;
  readonly snapshot?: IAxisSnapshot;
  readonly secureStorage?: AxisSecureStorage;
  /** The registry the window's key handler reads (main.tsx); a private one when absent. */
  readonly commands?: CommandRegistry;
}

export const PALETTE_COMMAND = "axis.palette.open";
const PALETTE_CHORD = parseChord("Mod+K");

function focusMain(): void {
  document.querySelector<HTMLElement>('[data-region="main"]')?.focus();
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

  const platform: Platform = props.isMac ? "mac" : "other";
  const registry = useMemo(() => props.commands ?? new CommandRegistry(), [props.commands]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isOpen = useRef(false);
  const opener = useRef<Element | null>(null);
  const openPalette = () => {
    if (isOpen.current) return;
    isOpen.current = true;
    opener.current = document.activeElement;
    setPaletteOpen(true);
  };
  const closePalette = () => {
    isOpen.current = false;
    setPaletteOpen(false);
  };

  useEffect(() => {
    const removers = [
      registry.register({ id: PALETTE_COMMAND, title: "Show all commands", chord: "Mod+K", run: openPalette }),
      ...NAV_ROUTES.map((r) =>
        registry.register({ id: `axis.go.${r.id}`, title: `Go to ${r.label}`, run: () => (navigate(r.id), focusMain()) }),
      ),
    ];
    return () => removers.forEach((remove) => remove());
  }, [registry]);

  // After the palette closes (and the frame is no longer inert): focus goes back to where it was, or to the main region
  // when that element has gone; then the chosen command runs, so one that moves focus (Go to) wins, and F6 counts from
  // where the user was.
  const wasOpen = useRef(false);
  const chosen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (paletteOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    else focusMain();
    const id = chosen.current;
    chosen.current = undefined;
    if (id !== undefined) registry.run(id);
  }, [paletteOpen]);

  const commands = paletteOpen ? registry.list().filter((c) => c.id !== PALETTE_COMMAND && (c.enabled === undefined || c.enabled())) : [];
  return (
    <>
      <Frame
        route={route}
        title={title}
        activity={ACTIVITY[screen.kind]!}
        readOnly={screen.readOnly}
        notices={route === "states" ? [] : screen.notices}
        announcement={title}
        onNavigate={navigate}
        palette={{ keys: chordKeys(PALETTE_CHORD, platform), aria: chordAria(PALETTE_CHORD, platform), onOpen: openPalette }}
        inert={paletteOpen}
      >
        {route === "states" ? <Gallery isMac={props.isMac} /> : <RouteScreen route={route} screen={screen} />}
      </Frame>
      {paletteOpen && <CommandPalette commands={commands} platform={platform} onClose={closePalette} onRun={(id) => (chosen.current = id)} />}
    </>
  );
}
