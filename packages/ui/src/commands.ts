// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The own shell's command registry (OS-6): one place that names every command, its title and its chord, so the
// palette, the shortcut badges and the key handler all read the same entry. A command runs only through `run` or a
// resolved key event; a scope narrows a chord to one part of the frame (the dashboard list, a card).

import { chordMatches, isTypingChord, parseChord, sameChord, type Chord, type KeyGesture, type Platform } from "./keys.js";

export interface CommandSpec {
  /** Stable internal id, for example `axis.view.toggle`. Never shown. */
  readonly id: string;
  readonly title: string;
  readonly chord?: string;
  /** Where the chord applies: `global`, or a scope the frame reports as active (for example `dashboard-list`). */
  readonly scope?: string;
  readonly enabled?: () => boolean;
  readonly run: () => void;
}

export interface Command extends CommandSpec {
  readonly scope: string;
  readonly parsedChord: Chord | undefined;
}

/** What the key handler knows about where the event happened. */
export interface KeyContext {
  readonly platform: Platform;
  readonly activeScopes: readonly string[];
  /** The focus is in a text input, a text area or a contenteditable element. */
  readonly inEditable: boolean;
}

const ID = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  /** Adds a command; returns the function that removes it. Throws on a bad or taken id, or a chord taken in the scope. */
  register(spec: CommandSpec): () => void {
    if (!ID.test(spec.id)) throw new Error(`not a command id: ${spec.id}`);
    if (this.commands.has(spec.id)) throw new Error(`command already registered: ${spec.id}`);
    const scope = spec.scope ?? "global";
    const parsedChord = spec.chord === undefined ? undefined : parseChord(spec.chord);
    if (parsedChord !== undefined) {
      for (const other of this.commands.values()) {
        if (other.scope === scope && other.parsedChord !== undefined && sameChord(other.parsedChord, parsedChord)) throw new Error(`chord ${spec.chord} is taken in ${scope} by ${other.id}`);
      }
    }
    const command: Command = { ...spec, scope, parsedChord };
    this.commands.set(spec.id, command);
    return () => {
      if (this.commands.get(spec.id) === command) this.commands.delete(spec.id);
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** Every command, sorted by title, for the palette. */
  list(): readonly Command[] {
    return [...this.commands.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * The command a key event runs, or undefined. An active scope wins over `global` for the same chord, so a list can
   * take a key the frame also binds; a typing chord (a bare letter) never fires inside an input; a disabled command is
   * not returned.
   */
  resolve(event: KeyGesture, context: KeyContext): Command | undefined {
    let found: Command | undefined;
    for (const command of this.commands.values()) {
      const chord = command.parsedChord;
      if (chord === undefined || !chordMatches(event, chord, context.platform)) continue;
      if (context.inEditable && isTypingChord(chord)) continue;
      if (command.enabled !== undefined && !command.enabled()) continue;
      if (command.scope !== "global" && !context.activeScopes.includes(command.scope)) continue;
      if (found === undefined || (found.scope === "global" && command.scope !== "global")) found = command;
    }
    return found;
  }

  /** Runs a command by id when it exists and is enabled; returns whether it ran. */
  run(id: string): boolean {
    const command = this.commands.get(id);
    if (command === undefined || (command.enabled !== undefined && !command.enabled())) return false;
    command.run();
    return true;
  }
}
