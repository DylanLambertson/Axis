// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** The most characters held while the numeric id of an OSC is still unknown; past it the sequence is dropped (fails closed). */
export const OSC_HOLD_LIMIT = 64;

/**
 * OSC ids that Code OSS acts on to record a working directory or a shell-integration event: 7 (`file://`), 9 (`9;9;<cwd>`),
 * 133 (FinalTerm marks), 633 (VS Code) and 1337 (`CurrentDir=`). A CLI run has shell integration off and no nonce, so every one
 * of them is forged (PTY-3, PTY-7). Dropped whole: OSC 9 as a whole, because the sub-command check is the consumer's.
 */
export const DENIED_OSC_IDS: ReadonlySet<number> = new Set([7, 9, 133, 633, 1337]);

const ESC = 0x1b;
const BEL = 0x07;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const BIG = 1_000_000; // any id this large is not in the deny list; never grows further

/** C0 controls xterm.js executes or ignores without leaving the current state (`EXECUTABLES`): they do not end an OSC or an ESC. */
const isIgnorable = (c: number): boolean => (c <= 0x17 && c !== BEL) || c === 0x19 || (c >= 0x1c && c <= 0x1f);
/** Ends or aborts an OSC string in xterm.js: BEL, ST, ESC, CAN, SUB and every C1 control (0x80-0x9f). */
const endsOsc = (c: number): boolean => c === BEL || c === ESC || c === 0x18 || c === 0x1a || (c >= 0x80 && c <= 0x9f);

type Mode =
  | "ground"
  | "escape" // after ESC (and any ignorable controls): `]` or 0x9d here starts an OSC
  | "id" // inside an OSC whose id is not decided yet; the characters are held
  | "pass" // an OSC that is not denied: characters flow through until it ends
  | "drop"; // a denied (or oversized) OSC: characters are swallowed until it ends

/**
 * PTY-3 and PTY-7: removes every OSC whose id is in DENIED_OSC_IDS from a CLI run's output. It follows the transitions of the
 * xterm.js parser Code OSS uses, not a simplified grammar:
 * - ESC, and the 8-bit introducer 0x9d, start an OSC from every state (also inside another OSC, after ESC plus ignorable
 *   controls, inside DCS or CSI);
 * - an OSC ends or aborts on BEL, 0x9c, ESC, CAN, SUB and any other C1 control, and the ending character is then handled from
 *   the state it leads to;
 * - the id is read as xtermjs does: ASCII digits to the first `;`, parsed as an integer (so `0633` is 633), with ignorable C0
 *   controls skipped; a printable non-digit makes xterm ignore the whole sequence, so it is passed.
 * Memory is constant: only the id is held (OSC_HOLD_LIMIT characters at most, then the sequence is dropped); a partial sequence
 * is carried across chunks. Everything else passes unchanged. Characters are code points of the decoded stream.
 */
export class OscCwdFilter {
  private mode: Mode = "ground";
  private held = "";
  private id = -1;
  /**
   * An OSC was printed and the output has not closed it yet (it ended on the input side by a restart, or by an ESC that is held
   * back). Whatever follows a dropped sequence would otherwise continue it: `\x9d6 3` + dropped + `3;P;Cwd=` reads as id 633.
   * Dropping a sequence therefore first prints CAN, which aborts the open one exactly as xterm.js does when an OSC restarts.
   */
  private outOpen = false;
  /** The held ESC was printed early (a control arrived while the output still had an OSC open, which ESC has to close first). */
  private escOut = false;
  /** The sequence just dropped ended with ESC: a following `\` completes its terminator and is dropped too. */
  private swallowBackslash = false;

  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) out += this.step(ch.codePointAt(0) as number, ch);
    return out;
  }

  private step(c: number, ch: string): string {
    switch (this.mode) {
      case "ground":
        return this.ground(c, ch);
      case "escape":
        return this.escape(c, ch);
      case "id":
        return this.idChar(c, ch);
      case "pass":
        return this.stringChar(c, ch, true);
      case "drop":
        return this.stringChar(c, ch, false);
    }
  }

  private ground(c: number, ch: string): string {
    if (c === ESC) return this.toEscape();
    if (c === C1_OSC) return this.startOsc("\u009d");
    this.swallowBackslash = false;
    return ch;
  }

  private toEscape(): string {
    this.mode = "escape";
    // The ESC itself is held back (not output) so that an OSC can still be removed whole; ESC ESC stays in ESCAPE in xterm.
    return "";
  }

  private startOsc(intro: string): string {
    this.swallowBackslash = false;
    this.mode = "id";
    this.held = this.escOut && intro === "\x1b]" ? "]" : intro;
    this.escOut = false;
    this.id = -1;
    return "";
  }

  private escape(c: number, ch: string): string {
    if (c === 0x5d) return this.startOsc("\x1b]");
    if (c === C1_OSC) return this.startOsc("\u009d");
    if (c === ESC) return "";
    if (isIgnorable(c) || c === BEL || c === 0x7f) {
      // Executed (or ignored) by xterm in place. Where the output has no OSC open, its order against the held ESC does not matter;
      // where it has, the ESC has to come first (it ends that OSC; a DEL or BEL would not end it the same way).
      if (!this.outOpen || this.escOut) return ch;
      this.escOut = true;
      return "\x1b" + ch;
    }
    const swallow = this.swallowBackslash && c === 0x5c;
    this.swallowBackslash = false;
    this.mode = "ground";
    if (swallow) return "";
    this.outOpen = false; // ESC and the next character end whatever the output had open
    const esc = this.escOut ? "" : "\x1b";
    this.escOut = false;
    return esc + ch;
  }

  private idChar(c: number, ch: string): string {
    if (c >= 0x30 && c <= 0x39) {
      this.id = Math.min(BIG, (this.id < 0 ? 0 : this.id) * 10 + (c - 0x30));
      return this.hold(ch);
    }
    if (c === 0x3b) return this.decide(ch, false);
    if (isIgnorable(c)) return this.hold(ch);
    if (endsOsc(c)) {
      const dropped = this.denied();
      return this.decide("", true) + this.ending(c, ch, dropped);
    }
    // A printable non-digit before `;`: xterm ignores the sequence from here on. It is not an id we can recognise.
    return this.decideInvalid(ch);
  }

  private hold(ch: string): string {
    this.held += ch;
    if (this.held.length > OSC_HOLD_LIMIT) {
      this.held = "";
      this.mode = "drop";
      return this.closeOpen();
    }
    return "";
  }

  private denied(): boolean {
    return DENIED_OSC_IDS.has(this.id);
  }

  /** The id is known (`;` seen, or the sequence ended). Denied: swallow. Otherwise print what was held. */
  private decide(ch: string, ended: boolean): string {
    if (this.denied()) {
      this.held = "";
      this.mode = ended ? "ground" : "drop";
      return this.closeOpen();
    }
    const out = this.held + ch;
    this.held = "";
    this.mode = ended ? "ground" : "pass";
    this.outOpen = true;
    return out;
  }

  private decideInvalid(ch: string): string {
    const out = this.held + ch;
    this.held = "";
    this.mode = "pass";
    this.outOpen = true;
    return out;
  }

  private closeOpen(): string {
    if (!this.outOpen) return "";
    this.outOpen = false;
    return "\x18";
  }

  /** The character that ended an OSC, handled from the state it leads to. `dropped` tells whether the OSC was swallowed. */
  private ending(c: number, ch: string, dropped: boolean): string {
    if (c === ESC) {
      this.swallowBackslash = dropped;
      return this.toEscape();
    }
    if (c === C1_OSC) return this.startOsc("\u009d");
    if (dropped && (c === BEL || c === C1_ST)) return "";
    this.outOpen = false; // BEL, ST, CAN, SUB and the other C1 controls close or abort what the output has open
    return ch;
  }

  private stringChar(c: number, ch: string, pass: boolean): string {
    if (endsOsc(c) || c === C1_OSC) {
      this.mode = "ground";
      return this.ending(c, ch, !pass);
    }
    return pass ? ch : "";
  }
}
