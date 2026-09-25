/**
 * A drive pairing link (`…/settings/vaults#pair-drive=<code>`, ADR 0144)
 * carries a slot key in its fragment. The fragment never reaches a server,
 * but it stays in the address bar and in history — which some browsers sync
 * to other devices — until something removes it. Boot removes it at once,
 * and again on every in-page arrival (a link pasted into a tab already on
 * the page is a fragment change, not a load), whether or not Networking is on
 * or a vault is open. The code is held in memory only, for the Tailnet sync
 * panel to take; a reload before it does costs opening the link again.
 */

const LINK_KEY = "pair-drive=";

let linked = "";
const listeners = new Set<() => void>();

/** Take a pairing code out of the address bar, leaving no trace of it. */
export function captureLinkedPairing(
  location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): void {
  const at = location.hash.indexOf(LINK_KEY);
  if (at === -1) return;
  const code = location.hash.slice(at + LINK_KEY.length);
  history.replaceState(history.state, "", location.pathname + location.search);
  try {
    linked = decodeURIComponent(code);
  } catch {
    linked = "";
  }
  for (const listener of listeners) listener();
}

/**
 * Capture now and on every later in-page arrival. Registered at boot, before
 * the router's own `popstate` listener, so the router never sees the code.
 */
export function watchLinkedPairing(
  target: Pick<Window, "addEventListener"> = window,
  location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): void {
  captureLinkedPairing(location, history);
  const again = () => captureLinkedPairing(location, history);
  target.addEventListener("hashchange", again);
  target.addEventListener("popstate", again);
}

/** Hear about a code captured while the panel is already open. */
export function subscribeLinkedPairing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The code boot took from the address bar, handed over once. */
export function takeLinkedPairing(): string {
  const code = linked;
  linked = "";
  return code;
}
