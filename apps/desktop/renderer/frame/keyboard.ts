// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The frame's key handling (OS-6): one window listener resolves each key through the command registry, and F6 /
// Shift+F6 move focus between the frame's regions (`[data-region]`, in document order). The approval shortcut is not
// here: only a decision card handles it, through its own gate. While a modal is open it owns the keyboard: the
// listener leaves its keys alone.

import { CommandRegistry, nextRegionIndex, type Platform } from "@axis/ui";

export function platformOf(nav: { readonly platform?: string; readonly userAgent: string }): Platform {
  return /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent) ? "mac" : "other";
}

function isEditable(node: Element | null): boolean {
  if (node === null) return false;
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset"].includes(node.type);
  return node instanceof HTMLElement && node.isContentEditable;
}

/**
 * Moves focus to the next (or previous) visible region; a region is focusable itself (`tabIndex=-1`). Regions are
 * taken by position, not by name, so two regions that share a name cannot trap F6 on the first.
 */
export function cycleRegion(doc: Document, backwards: boolean): void {
  const regions = [...doc.querySelectorAll<HTMLElement>("[data-region]")].filter((r) => r.getClientRects().length > 0 || r.offsetParent !== null);
  const current = doc.activeElement?.closest<HTMLElement>("[data-region]");
  const at = nextRegionIndex(regions.length, current ? regions.indexOf(current) : -1, backwards);
  const element = at === undefined ? undefined : regions[at];
  if (element === undefined) return;
  if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) element.tabIndex = -1;
  element.focus();
}

/** The frame's commands and the window listener; returns the function that removes both. */
export function installKeyboard(win: Window, registry: CommandRegistry, platform: Platform = platformOf(win.navigator)): () => void {
  const removers = [
    registry.register({ id: "axis.region.next", title: "Focus next region", chord: "F6", run: () => cycleRegion(win.document, false) }),
    registry.register({ id: "axis.region.previous", title: "Focus previous region", chord: "Shift+F6", run: () => cycleRegion(win.document, true) }),
  ];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const active = win.document.activeElement;
    if (active?.closest('[aria-modal="true"]')) return; // an open modal (the palette) owns the keyboard
    const scopes = [...(active?.closest<HTMLElement>("[data-scope]") ? [active.closest<HTMLElement>("[data-scope]")!.dataset.scope ?? ""] : [])];
    const command = registry.resolve(event, { platform, activeScopes: scopes, inEditable: isEditable(active) });
    if (command === undefined) return;
    event.preventDefault();
    command.run();
  };
  win.addEventListener("keydown", onKeyDown);
  return () => {
    win.removeEventListener("keydown", onKeyDown);
    removers.forEach((r) => r());
  };
}
