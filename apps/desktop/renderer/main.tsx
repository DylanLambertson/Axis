// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Renderer entry: applies the colour tokens, sets the title from the brand module, mounts the frame.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { cssVariables, windowTitle, type ThemeKind } from "@axis/ui";
import { App } from "./App.js";

function applyTokens(theme: ThemeKind): void {
  for (const [name, value] of cssVariables(theme)) document.documentElement.style.setProperty(name, value);
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
applyTokens(dark.matches ? "dark" : "light");
dark.addEventListener("change", (e) => applyTokens(e.matches ? "dark" : "light"));
document.title = windowTitle();

/** Marks the page once React has committed the frame (the smoke test waits for it). */
function Root() {
  useEffect(() => {
    document.documentElement.dataset.axisShell = "mounted";
  }, []);
  return <App />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root element");
createRoot(root).render(<Root />);
