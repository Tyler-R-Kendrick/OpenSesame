/**
 * Read a password from the controlling terminal without echoing it. Nothing
 * else is accepted — not a pipe, not an argument, not an environment
 * variable — so a master password never lands in shell history, `ps`, or a
 * file another process can read.
 */
import type { ReadStream } from "node:tty";

export class NoTerminalError extends Error {
  constructor() {
    super("reads the master password from a terminal only");
    this.name = "NoTerminalError";
  }
}

const ENTER = new Set(["\r", "\n", "\u0004"]);
const BACKSPACE = new Set(["\u007f", "\b"]);
const INTERRUPT = "\u0003";

/** The password so far, and whether Enter, Ctrl-D or Ctrl-C ended it. */
export type KeyStep = Readonly<{
  typed: string;
  done: boolean;
  interrupted: boolean;
}>;

/** Fold one keystroke chunk into `typed`; `done` once Enter or Ctrl-D arrives. */
export function applyKeys(typed: string, chunk: string): KeyStep {
  // An arrow or function key arrives as one escape sequence; it types nothing.
  if (chunk.startsWith("\u001b"))
    return { typed, done: false, interrupted: false };
  let next = typed;
  for (const char of chunk) {
    if (char === INTERRUPT) return { typed: "", done: true, interrupted: true };
    if (ENTER.has(char)) return { typed: next, done: true, interrupted: false };
    if (BACKSPACE.has(char)) next = next.slice(0, -1);
    else if (char >= " ") next += char;
  }
  return { typed: next, done: false, interrupted: false };
}

export function readPasswordFromTty(
  prompt: string,
  input: ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY) return Promise.reject(new NoTerminalError());
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let typed = "";
    const finish = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: string) => {
      const step = applyKeys(typed, chunk);
      typed = step.typed;
      if (!step.done) return;
      finish();
      if (step.interrupted) reject(new Error("interrupted"));
      else resolve(typed);
    };
    input.on("data", onData);
  });
}
