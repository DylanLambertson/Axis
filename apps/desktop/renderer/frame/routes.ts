// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The frame's router (OS-6): a closed set of routes in the URL hash, so a reload or a shortcut lands on the same page
// and nothing outside this table can be navigated to. The navigation rail lists the destinations in `NAV_ROUTES`;
// `states` is the design-review gallery and is reached by its hash only.

export const NAV_ROUTES = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "workspaces", label: "Workspaces", icon: "▦" },
  { id: "agents", label: "Agents", icon: "◎" },
  { id: "tasks", label: "Tasks", icon: "☑" },
] as const;

export type NavRouteId = (typeof NAV_ROUTES)[number]["id"];
export type RouteId = NavRouteId | "states";

const ROUTES: ReadonlySet<string> = new Set<string>([...NAV_ROUTES.map((r) => r.id), "states"]);

/** The route a hash names; anything else (empty, unknown, extra segments, a query) is home. */
export function routeOf(hash: string): RouteId {
  const id = hash.startsWith("#/") ? hash.slice(2) : "";
  return ROUTES.has(id) ? (id as RouteId) : "home";
}

export function hashOf(route: RouteId): string {
  return `#/${route}`;
}

/** The page title spoken and shown for a route. */
export function routeTitle(route: RouteId): string {
  return route === "states" ? "State gallery" : NAV_ROUTES.find((r) => r.id === route)!.label;
}
