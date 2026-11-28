// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The terminal pane's frame and its states (OS-6). The terminal itself arrives with DC-3a/b and OS-16; until then the
// pane says so. The states that build will need exist now so the layout does not move when it lands.

export type TerminalPaneState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "connecting" }
  | { readonly kind: "exited"; readonly code: number };

export interface TerminalPaneProps {
  readonly state: TerminalPaneState;
  readonly onRestart?: () => void;
  /** False for a sample (the state gallery): no landmark and no F6 region, so a page of samples has one of neither. */
  readonly region?: boolean;
}

export function TerminalPane({ state, onRestart, region = true }: TerminalPaneProps) {
  const Root = region ? "section" : "div";
  return (
    <Root className="axis-terminal" {...(region ? { "aria-label": "Terminal", "data-region": "terminal", tabIndex: -1 } : {})}>
      <header className="axis-terminal__head">
        <span className="axis-label">Terminal</span>
      </header>
      <div className="axis-terminal__body" aria-busy={state.kind === "connecting"}>
        {state.kind === "unavailable" && <p>The terminal is not part of this build yet. Use a terminal of your own in the workspace folder for now.</p>}
        {state.kind === "connecting" && <p>Starting the terminal…</p>}
        {state.kind === "exited" && (
          <>
            <p role="status">Terminal process exited with code {state.code}.</p>
            <button type="button" className="axis-btn axis-btn--secondary" onClick={onRestart} disabled={onRestart === undefined}>
              Restart terminal
            </button>
          </>
        )}
      </div>
    </Root>
  );
}
