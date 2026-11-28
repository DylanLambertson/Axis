// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Renderer entry: applies the colour tokens for the OS theme, sets the title from the brand module, installs the key
// handling and mounts the frame.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { CommandRegistry, cssVariables, windowTitle, type ThemeKind } from "@axis/ui";
import { App } from "./App.js";
import { installKeyboard, platformOf } from "./frame/keyboard.js";

function applyTokens(theme: ThemeKind): void {
  const root = document.documentElement;
  for (const [name, value] of cssVariables(theme)) root.style.setProperty(name, value);
  root.dataset.theme = theme;
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
applyTokens(dark.matches ? "dark" : "light");
dark.addEventListener("change", (e) => applyTokens(e.matches ? "dark" : "light"));
document.title = windowTitle();
const commands = new CommandRegistry();
installKeyboard(window, commands);

/** Marks the page once React has committed the frame (the smoke test waits for it). */
function Root() {
  useEffect(() => {
    document.documentElement.dataset.axisShell = "mounted";
  }, []);
  return <App initialHash={window.location.hash} isMac={platformOf(navigator) === "mac"} commands={commands} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root element");
createRoot(root).render(<Root />);
