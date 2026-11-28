// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The command palette (OS-6): a modal dialog over a scrim with one combobox input and a listbox of the registry's
// commands, each with its keycaps. Focus stays in the input (the active option is `aria-activedescendant`); an
// unmodified, non-repeated Enter runs the active command, Escape or a click on the scrim closes it, and the app returns
// focus to where it was. Keys that belong to an input method (`paletteKeyAction`: the event's flag, keyCode 229, or a
// composition the input saw start and not yet end) are never read as palette keys.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { chordKeys, filterCommands, paletteKeyAction, paletteMove, type Command, type Platform } from "@axis/ui";
import { Keycaps } from "./Keycaps.js";

export interface CommandPaletteProps {
  readonly commands: readonly Command[];
  readonly platform: Platform;
  /** Closes the palette; the app restores focus. */
  readonly onClose: () => void;
  /** The command chosen, by id, just before the palette asks to close; the app runs it once focus is back. */
  readonly onRun: (id: string) => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  /** An input-method composition on the input, from compositionstart to compositionend: its keys are not palette keys. */
  const composing = useRef(false);
  const id = useId();
  const shown = filterCommands(props.commands, query);
  const at = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);

  useEffect(() => input.current?.focus(), []);

  function run(command: Command | undefined) {
    if (command === undefined) return;
    props.onClose();
    props.onRun(command.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const native = event.nativeEvent;
    const action = paletteKeyAction({ key: event.key, isComposing: native.isComposing || composing.current, keyCode: native.keyCode, repeat: event.repeat, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
    switch (action) {
      case "none":
        return;
      case "close":
        props.onClose();
        break;
      case "run":
        run(shown[at]);
        break;
      case "next":
      case "previous": {
        const next = paletteMove(shown.length, at, action === "next" ? "ArrowDown" : "ArrowUp");
        if (next !== undefined) setActive(next);
        break;
      }
      case "hold": // the input is the dialog's only tab stop
      case "swallow": // a held Enter neither chooses nor reaches the page
        break;
    }
    event.preventDefault();
  }

  return (
    <div className="axis-scrim" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="axis-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <label className="axis-sr" htmlFor={`${id}q`}>
          Command
        </label>
        <input
          ref={input}
          id={`${id}q`}
          className="axis-palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}list`}
          aria-autocomplete="list"
          aria-activedescendant={at < 0 ? undefined : `${id}o${at}`}
          placeholder="Type a command"
          autoComplete="off"
          spellCheck={false}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <ul id={`${id}list`} className="axis-palette__list" role="listbox" aria-label="Commands">
          {shown.map((command, i) => (
            <li
              key={command.id}
              id={`${id}o${i}`}
              className="axis-palette__item"
              role="option"
              aria-selected={i === at}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(command)}
            >
              <span>{command.title}</span>
              {command.parsedChord !== undefined && <Keycaps keys={chordKeys(command.parsedChord, props.platform)} />}
            </li>
          ))}
        </ul>
        {shown.length === 0 && (
          <p className="axis-palette__empty" role="status">
            No command matches.
          </p>
        )}
      </div>
    </div>
  );
}
