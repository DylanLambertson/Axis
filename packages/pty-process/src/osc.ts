// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

const ESC = "\x1b";
const BEL = "\x07";
const C1_OSC = "\u009d";
const C1_ST = "\u009c";
/** Longest OSC 633 body held while waiting for its terminator; past it the sequence is dropped and its tail prints as plain text. */
export const OSC_HOLD_LIMIT = 4096;

/**
 * PTY-3 and PTY-7: a CLI run has shell integration disabled and no nonce, so every OSC 633 sequence in its output is forged
 * (`OSC 633 ; P ; Cwd=...` would steer where a split pane opens). The filter removes them all, across chunk boundaries, and
 * holds at most OSC_HOLD_LIMIT characters. Every other byte passes through unchanged.
 */
export class Osc633Filter {
  private held = "";
  private mode: "text" | "escape" | "body" | "body-escape" = "text";

  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      switch (this.mode) {
        case "text":
          if (ch === ESC) {
            this.mode = "escape";
            this.held = ch;
          } else if (ch === C1_OSC) {
            this.mode = "body";
            this.held = ch;
          } else out += ch;
          break;
        case "escape":
          if (ch === "]") {
            this.mode = "body";
            this.held += ch;
          } else if (ch === ESC) {
            out += this.held; // a lone ESC; the new one may start a sequence
            this.held = ch;
          } else {
            out += this.held + ch;
            this.reset();
          }
          break;
        case "body":
          if (ch === BEL || ch === C1_ST) out += this.finish(ch);
          else if (ch === ESC) this.mode = "body-escape";
          else this.hold(ch);
          break;
        case "body-escape":
          if (ch === "\\") out += this.finish(ESC + ch);
          else {
            this.mode = "body";
            this.hold(ESC + ch);
          }
          break;
      }
      if (this.held.length > OSC_HOLD_LIMIT) out += this.overflow();
    }
    return out;
  }

  private hold(s: string): void {
    this.held += s;
  }

  private reset(): void {
    this.held = "";
    this.mode = "text";
  }

  /** A complete OSC: dropped when it is 633, printed back as it came otherwise. */
  private finish(terminator: string): string {
    const kept = this.is633() ? "" : this.held + terminator;
    this.reset();
    return kept;
  }

  private is633(): boolean {
    return /^633(?:;|$)/.test(this.held.replace(/^(?:\x1b\]|\u009d)/, ""));
  }

  private overflow(): string {
    const printed = this.is633() ? "" : this.held;
    this.reset();
    return printed;
  }
}
