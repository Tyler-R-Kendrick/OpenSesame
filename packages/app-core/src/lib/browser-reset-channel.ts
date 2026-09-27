/**
 * How the tab that resets this browser (`browser-reset.ts`) tells the others.
 * Its own module, importing nothing but the ports, so the shell's entry can
 * listen from the first moment without loading the reset itself.
 */

import { openBroadcast } from "../ports.js";

const CHANNEL = "opensesame.browser-reset";

/** This tab, so it can tell its own announcement from another tab's. */
const TAB = crypto.randomUUID();

type ResetMessage = Readonly<{ kind: "reset"; tab: string }>;

function isResetFromElsewhere(
  event: MessageEvent<Partial<ResetMessage> | null>,
): boolean {
  // Anything else on the channel (a string, null, an older shape) has no
  // `kind` of "reset" and is ignored.
  return event.data?.kind === "reset" && event.data.tab !== TAB;
}

/** Tell every other tab of this origin that its storage is gone. */
export function announceBrowserReset(): void {
  const channel = openBroadcast(CHANNEL);
  if (!channel) return;
  channel.postMessage({ kind: "reset", tab: TAB } satisfies ResetMessage);
  channel.close();
}

/**
 * Run `handler` when another tab of this origin resets the browser. The shell
 * reloads: this tab's memory describes storage that no longer exists, and
 * anything it wrote back would outlive the reset.
 */
export function onBrowserReset(handler: () => void): () => void {
  const channel = openBroadcast(CHANNEL);
  if (!channel) return () => undefined;
  const listener = (event: MessageEvent<Partial<ResetMessage> | null>) => {
    if (isResetFromElsewhere(event)) handler();
  };
  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
  };
}
