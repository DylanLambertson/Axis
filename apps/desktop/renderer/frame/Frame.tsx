// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The own shell's frame (OS-6, direction C): the top bar, the labelled navigation rail and the main region, each a
// landmark and an F6 region (`data-region`), and one polite live region for announcements. The rail is one tab stop:
// arrows move within it (roving tabindex) and the current page carries `aria-current="page"`. The top bar opens the
// command palette, with the chord's keycaps on the button.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { IAxisNotice } from "@axis/shell-core";
import { BRAND, rovingIndex } from "@axis/ui";
import { Keycaps } from "../components/Keycaps.js";
import { Notices } from "../components/Notice.js";
import { NAV_ROUTES, type NavRouteId, type RouteId } from "./routes.js";

export interface FrameProps {
  readonly route: RouteId;
  readonly title: string;
  /** The top bar's activity line, for example "Not connected"; always words, never only a glyph. */
  readonly activity: string;
  readonly readOnly: boolean;
  readonly notices: readonly IAxisNotice[];
  readonly announcement: string;
  readonly onNavigate: (route: NavRouteId) => void;
  /** The palette trigger: its keycaps and `aria-keyshortcuts` come from the registry's chord. */
  readonly palette: { readonly keys: readonly string[]; readonly aria: string; readonly onOpen: () => void };
  /** While a modal (the palette) is open, the frame behind it takes no focus or input. */
  readonly inert?: boolean;
  readonly children: ReactNode;
}

/**
 * The rail's one tab stop, in React state: arrows move it without navigating; a route change (a click, the palette, the
 * hash) puts it back on the current page. Every button's `tabIndex` is derived from it, so there is never a second stop.
 */
function Rail({ route, onNavigate }: { readonly route: RouteId; readonly onNavigate: (route: NavRouteId) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const current = Math.max(0, NAV_ROUTES.findIndex((r) => r.id === route));
  const [roved, setRoved] = useState<{ readonly route: RouteId; readonly stop: number }>({ route, stop: current });
  const stop = roved.route === route ? roved.stop : current;
  // Forget a roved stop once the route changes, so coming back to a route later does not bring it back.
  useEffect(() => setRoved({ route, stop: current }), [route, current]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    const next = rovingIndex(buttons.length, at, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setRoved({ route, stop: next });
    buttons[next]?.focus();
  }
  return (
    <nav className="axis-rail" aria-label="Project" data-region="nav">
      <div ref={list} className="axis-rail__list" onKeyDown={onKeyDown}>
        {NAV_ROUTES.map((r, i) => (
          <button
            key={r.id}
            type="button"
            className="axis-rail__item"
            aria-current={r.id === route ? "page" : undefined}
            tabIndex={i === stop ? 0 : -1}
            onClick={() => onNavigate(r.id)}
          >
            <span className="axis-rail__icon" aria-hidden="true">
              {r.icon}
            </span>
            <span>{r.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

export function Frame(props: FrameProps) {
  return (
    <div className="axis-frame" inert={props.inert === true}>
      <header className="axis-top" data-region="top" tabIndex={-1}>
        <span className="axis-top__brand">{BRAND.productName}</span>
        <nav className="axis-top__crumb" aria-label="Breadcrumb">
          <span aria-current="page">{props.title}</span>
        </nav>
        <span className="axis-top__gap" />
        <button type="button" className="axis-btn axis-btn--secondary axis-top__cmd" aria-haspopup="dialog" aria-keyshortcuts={props.palette.aria} onClick={props.palette.onOpen}>
          Commands <Keycaps keys={props.palette.keys} />
        </button>
        {props.readOnly && <span className="axis-tag axis-tag--warn">Read only</span>}
        <span className="axis-top__activity">{props.activity}</span>
      </header>
      <div className="axis-body">
        <Rail route={props.route} onNavigate={props.onNavigate} />
        <main className="axis-main" data-region="main" tabIndex={-1} aria-labelledby="axis-page-title">
          <h1 id="axis-page-title" className="axis-main__title">
            {props.title}
          </h1>
          <Notices notices={props.notices} />
          {props.children}
        </main>
      </div>
      <div className="axis-sr" aria-live="polite" aria-atomic="true">
        {props.announcement}
      </div>
    </div>
  );
}
