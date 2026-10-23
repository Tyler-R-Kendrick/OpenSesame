/**
 * Put a vault field on the local clipboard. The value is written to the
 * clipboard tool's stdin and nowhere else.
 */
import { spawn } from "node:child_process";
import {
  clipboardEnvironment,
  resolveCredentialHelper,
} from "./parity-node.js";

const TOOLS: readonly (readonly string[])[] = [
  ["wl-copy"],
  ["xclip", "-selection", "clipboard"],
  ["xsel", "--clipboard", "--input"],
  ["pbcopy"],
];

function writeTo(command: string, args: readonly string[], text: string) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = spawn(resolveCredentialHelper(command), args, {
      stdio: ["pipe", "ignore", "ignore"],
      // Clipboard helpers are credential-bearing: they get the same screened
      // environment as every other secret-bearing helper.
      env: clipboardEnvironment(process.env),
      shell: false,
      // A wedged helper must not hold the vault value or the CLI forever.
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    child.on("error", () =>
      finish(new Error(`${command} could not be started`)),
    );
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited ${code}`));
    });
    // A helper that exits before reading stdin emits EPIPE here. Attach the
    // listener before writing so that never becomes an uncaught error.
    child.stdin.on("error", () =>
      finish(new Error(`${command} closed its input`)),
    );
    child.stdin.end(text);
  });
}

/** The first clipboard tool that accepts the text wins. */
export async function writeClipboard(text: string): Promise<void> {
  let last: unknown;
  for (const [command, ...args] of TOOLS) {
    if (command === undefined) continue;
    try {
      await writeTo(command, args, text);
      return;
    } catch (error) {
      last = error;
    }
  }
  const detail = last instanceof Error ? last.message : "none installed";
  throw new Error(
    `No clipboard tool accepted the text (${detail}). Install wl-copy, xclip, xsel, or pbcopy.`,
  );
}
