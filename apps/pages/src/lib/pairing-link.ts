/**
 * A drive pairing link (`…/settings/vaults#pair-drive=<code>`, ADR 0144)
 * carries a slot key in its fragment. The fragment never reaches a server,
 * but it stays in the address bar and in history — which some browsers sync
 * to other devices — until something removes it. Boot removes it at once,
 * whether or not Networking is on or a vault is open, and holds the code in
 * memory only, for the Tailnet sync panel to take. A reload before the panel
 * takes it costs opening the link again.
 */

const LINK_KEY = "pair-drive=";

let linked = "";

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
}

/** The code boot took from the address bar, handed over once. */
export function takeLinkedPairing(): string {
  const code = linked;
  linked = "";
  return code;
}
