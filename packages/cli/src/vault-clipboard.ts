/**
 * Put a vault field on the local clipboard. The value is written to the
 * clipboard tool's stdin and nowhere else.
 */
import { spawn } from "node:child_process";

const TOOLS: readonly (readonly string[])[] = [
  ["wl-copy"],
  ["xclip", "-selection", "clipboard"],
  ["xsel", "--clipboard", "--input"],
  ["pbcopy"],
];

function writeTo(command: string, args: readonly string[], text: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
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
