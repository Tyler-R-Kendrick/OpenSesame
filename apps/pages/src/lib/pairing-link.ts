/**
 * A pairing link carries a secret in its fragment: a drive's slot key
 * (`…/settings/vaults#pair-drive=<code>`, ADR 0144) or a tailnet device
 * management code (`…/identity?view=devices#pair-tailnet=<code>`, ADR 0169).
 * The fragment never reaches a server, but it stays in the address bar and in
 * history — which some browsers sync to other devices — until something
 * removes it. Boot removes it at once, and again on every in-page arrival (a
 * link pasted into a tab already on the page is a fragment change, not a
 * load), whether or not the capability that uses it is on or a vault is open.
 * The code is held in memory only, for its panel to take; a reload before it
 * does costs opening the link again.
 */

type Address = Pick<Location, "hash" | "pathname" | "search">;
type History_ = Pick<History, "replaceState" | "state">;

/** One kind of code a link may carry, held until its panel takes it. */
function linkCapture(key: string) {
  let linked = "";
  const listeners = new Set<() => void>();
  return {
    capture(location: Address, history: History_): void {
      const at = location.hash.indexOf(key);
      if (at === -1) return;
      const code = location.hash.slice(at + key.length);
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
      try {
        linked = decodeURIComponent(code);
      } catch {
        linked = "";
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take(): string {
      const code = linked;
      linked = "";
      return code;
    },
  };
}

const drive = linkCapture("pair-drive=");
const tailnet = linkCapture("pair-tailnet=");

/** Take any pairing code out of the address bar, leaving no trace of it. */
export function captureLinkedPairing(
  location: Address = window.location,
  history: History_ = window.history,
): void {
  drive.capture(location, history);
  tailnet.capture(location, history);
}

/**
 * Capture now and on every later in-page arrival. Registered at boot, before
 * the router's own `popstate` listener, so the router never sees the code.
 */
export function watchLinkedPairing(
  target: Pick<Window, "addEventListener"> = window,
  location: Address = window.location,
  history: History_ = window.history,
): void {
  captureLinkedPairing(location, history);
  const again = () => captureLinkedPairing(location, history);
  target.addEventListener("hashchange", again);
  target.addEventListener("popstate", again);
}

/** Hear about a drive code captured while the panel is already open. */
export const subscribeLinkedPairing = drive.subscribe;

/** The drive code boot took from the address bar, handed over once. */
export const takeLinkedPairing = drive.take;

/** Hear about a tailnet code captured while the device panel is open. */
export const subscribeLinkedTailnetPairing = tailnet.subscribe;

/** The tailnet code boot took from the address bar, handed over once. */
export const takeLinkedTailnetPairing = tailnet.take;
