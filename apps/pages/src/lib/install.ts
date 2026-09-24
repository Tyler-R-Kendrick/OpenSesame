/**
 * Installing this app — the affordance every browser hides in a menu.
 *
 * `apps/pages` is a real installable PWA (service worker, manifest, offline
 * shell), and until now the only way to install it was the icon Chromium
 * tucks into the address bar, or three taps into Safari's Share sheet. Neither
 * is discoverable, and both are the browser's UI rather than ours — so the app
 * never got to say *why* someone would want to.
 *
 * It matters here more than it does for most web apps. The vault is stored on
 * the device, in OPFS (`lib/kv.ts`), and a browser is entitled to evict a
 * tab's storage when the device runs short of room. An installed app is not
 * treated that way: Chromium grants persistent storage to installed sites
 * without asking, and iOS exempts a home-screen web app from the seven-day
 * eviction it applies to ordinary sites. So "install this" is not a growth
 * nudge on this screen — it is the difference between a vault the browser may
 * clear and one it will not.
 *
 * This module is the whole browser-facing surface of that, kept in one place
 * because `beforeinstallprompt` is not standardised: it is Chromium's, Safari
 * has no equivalent and no way for a page to open its install UI at all, and
 * the shape of both may change. Nothing outside this file touches either.
 *
 * Designed in `docs/design/pwa-install/`; the placement decision is
 * ADR 0085.
 */

import { overlapCast } from "@opensesame/os-domain";

/**
 * What the browser will let us do about installing, right now.
 *
 *  - `installed`     already running as an installed app, or it just was.
 *                    Nothing to offer; the app says so and stops.
 *  - `prompt`        Chromium has fired `beforeinstallprompt`, which is the
 *                    browser telling us this app is installable *and* handing
 *                    us the dialog to open. One gesture away.
 *  - `manual`        iOS and iPadOS. No API exists — Safari will not let a
 *                    page open its install UI — so the road is the reader's
 *                    own three taps, and all the app can do is name them.
 *  - `dismissed`     the dialog was opened and did not end in an install we
 *                    could confirm. Chromium's event is single-use, so our
 *                    road is spent until the next load — and this is the one
 *                    moment where pointing at the browser's own menu is the
 *                    honest thing to say, because it is genuinely the only way
 *                    left today. It deliberately covers "declined" and "we
 *                    could not read the answer" alike, which is why the copy
 *                    it renders asserts neither.
 *  - `unavailable`   everything else: Firefox on the desktop, an in-app
 *                    webview, a browser that has not decided yet. There is no
 *                    install to offer and no instruction worth giving.
 */
export type InstallState =
  | "installed"
  | "prompt"
  | "manual"
  | "dismissed"
  | "unavailable";

/**
 * Chromium's `BeforeInstallPromptEvent`, narrowed to what we use.
 *
 * `prompt()` resolves with the choice on current Chromium; older builds
 * resolved it with nothing and put the choice on `userChoice`. Both are read,
 * because the difference is invisible until an install silently reports the
 * wrong outcome.
 */
type UserChoice = { outcome: "accepted" | "dismissed" };

type InstallPromptEvent = Event & {
  prompt: () => Promise<UserChoice | undefined>;
  userChoice?: Promise<UserChoice>;
};

/**
 * The captured event, or null.
 *
 * Chromium fires this once per eligible page load and the event is single-use:
 * once `prompt()` has been called it is spent, and a second call throws. So it
 * is held here, consumed exactly once, and dropped.
 */
type InstallStore = {
  /** Chromium's captured event, consumed exactly once. */
  pending: InstallPromptEvent | null;
  /**
   * The dialog is open. Set synchronously when the event is consumed, because
   * consuming it empties `pending` — and without this the state would fall to
   * `unavailable` and the whole surface would vanish under the finger that
   * pressed the button, for as long as the browser's dialog is up.
   */
  prompting: boolean;
  /** Set by `appinstalled` or a confirmed accept — "it worked". */
  installedNow: boolean;
  /**
   * Set when the dialog was opened and no install came of it. Without it the
   * card would vanish the moment it was refused — the offer gone with no way
   * back — which reads as the app having taken the refusal badly.
   */
  declined: boolean;
  /**
   * The browser's OWN confirmation that this is an installed app — never our
   * optimistic accept. `promptInstall` sets `installedNow` the moment the
   * dialog resolves, which is *before* Chromium has installed anything.
   */
  confirmedInstalled: boolean;
  /** Whether the browser has agreed to keep this origin's storage. */
  persisted: boolean;
  /** The one persistence request per page load, shared by every caller. */
  persistenceInFlight: Promise<boolean> | null;
  /** Memoised device facts: neither can change within one document. */
  standalone: boolean | null;
  apple: boolean | null;
  armed: boolean;
  onBeforePrompt: ((event: Event) => void) | null;
  onInstalled: (() => void) | null;
  query: MediaQueryList | null;
  onDisplayMode: (() => void) | null;
};

/**
 * All of it in one record, so `resetInstallForTest` can replace the lot rather
 * than remember to clear each field. A flag that gets added here is reset by
 * construction; one added as a bare `let` beside it would not be, and the
 * cross-test bleed would surface as an unrelated failure.
 */
function freshStore(): InstallStore {
  return {
    pending: null,
    prompting: false,
    installedNow: false,
    declined: false,
    confirmedInstalled: false,
    persisted: false,
    persistenceInFlight: null,
    standalone: null,
    apple: null,
    armed: false,
    onBeforePrompt: null,
    onInstalled: null,
    query: null,
    onDisplayMode: null,
  };
}

let store: InstallStore = freshStore();

const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function detectStandalone(): boolean {
  if (globalThis.window === undefined) return false;
  // iOS predates `display-mode` and answers on the navigator instead. It is
  // non-standard and absent from lib.dom, so it is read through the boundary
  // rather than declared.
  const legacy: { standalone?: boolean } = overlapCast(window.navigator);
  if (legacy.standalone === true) return true;
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    // A browser without matchMedia is a browser that cannot install either.
    return false;
  }
}

/**
 * True when the page is displayed as an installed app rather than a tab.
 *
 * Memoised because this is the `getSnapshot` of a `useSyncExternalStore` and
 * runs on every render of every subscriber — but the display mode is a media
 * query the platform fires `change` on, so the memo is *invalidated* by that
 * event rather than trusted for the life of the document. Latching it would
 * leave a tab that became an installed app reporting otherwise, and would keep
 * `browserConfirmsInstalled` false so persistence was never asked for again.
 */
function runningStandalone(): boolean {
  store.standalone ??= detectStandalone();
  return store.standalone;
}

/** The media query whose `change` invalidates the memo above. */
function standaloneQuery(): MediaQueryList | null {
  if (globalThis.window === undefined) return null;
  try {
    return window.matchMedia?.("(display-mode: standalone)") ?? null;
  } catch {
    return null;
  }
}

/**
 * iOS and iPadOS, where installing exists but no API for it does.
 *
 * iPadOS 13+ reports itself as a Mac, so the touch count is what separates an
 * iPad from a desktop Safari that cannot install at all. Every browser on iOS
 * is WebKit underneath and reaches Add to Home Screen through the same Share
 * sheet, so this deliberately does not test for Safari specifically.
 */
function detectAppleTouchDevice(): boolean {
  if (globalThis.navigator === undefined) return false;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/** Memoised for the same reason as `runningStandalone`. */
function appleTouchDevice(): boolean {
  store.apple ??= detectAppleTouchDevice();
  return store.apple;
}

export const installSeams = {
  runningStandalone,
  appleTouchDevice,
};

/**
 * Where installing stands on this device.
 *
 * Ordered by what is true rather than what is preferable: an app already
 * installed is installed even if Chromium also offered a prompt, and a
 * captured prompt beats the iOS instructions on a device that somehow has
 * both.
 */
export function installState(): InstallState {
  if (store.installedNow || installSeams.runningStandalone())
    return "installed";
  // `prompting` matters as much as `pending`: consuming the event empties
  // `pending`, and without this the state would fall to `unavailable` and the
  // surface would vanish for as long as the browser's dialog is open.
  if (store.pending || store.prompting) return "prompt";
  if (store.declined) return "dismissed";
  if (installSeams.appleTouchDevice()) return "manual";
  return "unavailable";
}

/**
 * Whether there is an install to *offer* — as opposed to one to report.
 *
 * Not the render gate: that is `installWorthShowing`, which also admits the
 * states that report rather than offer. This is the narrower question, and the
 * one the capability registry describes.
 */
export function installOfferable(state: InstallState): boolean {
  return state === "prompt" || state === "manual";
}

/** Whether the install surface should render — an offer, or the fact of one. */
export function installWorthShowing(state: InstallState): boolean {
  return (
    installOfferable(state) || state === "installed" || state === "dismissed"
  );
}

/**
 * Start listening for the browser's install signals.
 *
 * Called from `main.tsx` before the first render, because Chromium fires
 * `beforeinstallprompt` as soon as it has decided the page is eligible — which
 * is routinely before React has mounted anything that could have listened.
 * Miss it and there is no second chance until the next load.
 *
 * Idempotent, so the hook can call it too and a test can arm a fresh jsdom.
 */
export function armInstall(): void {
  if (store.armed || globalThis.window === undefined) return;
  store.armed = true;

  store.onBeforePrompt = (event) => {
    // Without this Chromium shows its own mini-infobar, which is the
    // browser-chrome affordance this whole surface exists to replace.
    event.preventDefault();
    // SAFETY: only Chromium dispatches `beforeinstallprompt`, and it always
    // carries `prompt()`; `promptInstall` calls it inside a try/catch, so a
    // browser that ever dispatched the name without the method is handled
    // rather than trusted.
    store.pending = overlapCast(event);
    // A re-offer after a refusal is a fresh offer, not a lingering refusal.
    store.declined = false;
    announce();
  };

  store.onInstalled = () => {
    // Spent or not, the event is meaningless once the app is installed.
    store.pending = null;
    store.installedNow = true;
    store.confirmedInstalled = true;
    store.declined = false;
    announce();
    // Now, and not a moment earlier: this is the browser saying the origin is
    // an installed app, which is when Chromium grants persistence without
    // asking. Fire-and-forget — the surface must never wait on a storage
    // permission dialog.
    void ensurePersistence();
  };

  window.addEventListener("beforeinstallprompt", store.onBeforePrompt);
  window.addEventListener("appinstalled", store.onInstalled);

  // A tab can *become* an installed app's window. That is the browser
  // confirming the install on the roads where `appinstalled` never fires, so
  // it re-opens the persistence question rather than only the display.
  store.query = standaloneQuery();
  store.onDisplayMode = () => {
    store.standalone = detectStandalone();
    announce();
    if (store.standalone) void ensurePersistence();
  };
  store.query?.addEventListener?.("change", store.onDisplayMode);
}

/** Watch for install-state changes. Returns the unsubscribe. */
export function subscribeInstall(listener: () => void): () => void {
  armInstall();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ask the browser to keep this origin's storage.
 *
 * The install offer's one claim is that an installed app keeps its vault, so
 * the app asks rather than assuming: Chromium grants this without a prompt to
 * an installed site and refuses it to an ordinary tab, which is exactly the
 * distinction the copy draws. Best-effort by design — a browser without the
 * API, or one that says no, leaves the vault working exactly as it did.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

/** Whether the browser itself says this is an installed app. */
function browserConfirmsInstalled(): boolean {
  return store.confirmedInstalled || installSeams.runningStandalone();
}

/** Record a grant and wake the surfaces reading it. */
function recordPersisted(granted: boolean): boolean {
  if (granted && !store.persisted) {
    store.persisted = true;
    announce();
  }
  return granted;
}

/**
 * Ask once, and only when asking can succeed.
 *
 * Chromium grants this silently to an installed site and refuses a plain tab;
 * Firefox asks the person. So the gate is the browser's OWN confirmation —
 * `appinstalled`, or already running standalone — and deliberately not
 * `installState()`, which turns `installed` the instant `promptInstall` reads
 * an accept. Asking then would spend the single attempt this page load gets on
 * a refusal Chromium is guaranteed to give, and the retry that would have
 * succeeded a moment later would find the attempt already spent.
 *
 * The in-flight promise is shared rather than latched to a boolean, so a
 * second caller arriving mid-request gets the real answer instead of "somebody
 * else asked" — which would otherwise render "not kept" over a grant.
 */
export async function ensurePersistence(): Promise<boolean> {
  if (store.persisted) return true;
  if (await storagePersisted()) return recordPersisted(true);
  if (!browserConfirmsInstalled()) return false;
  store.persistenceInFlight ??= requestPersistence().then(recordPersisted);
  return store.persistenceInFlight;
}

/** Whether the browser has agreed to keep this origin's storage. */
export function installPersisted(): boolean {
  return store.persisted;
}

/** Whether this origin's storage is already exempt from eviction. */
export async function storagePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) === true;
  } catch {
    return false;
  }
}

/**
 * `retry` is not a failure: Chromium refused to trace the call to a user
 * activation and did NOT consume the event, so the button is still live and a
 * properly-traced press works. Reporting it as a refusal would send the reader
 * to the browser's own menu with a working control beside them.
 */
export type InstallOutcome = "accepted" | "dismissed" | "unknown" | "retry";

/**
 * Open the browser's install dialog.
 *
 * Must be called from a real user gesture — Chromium rejects a `prompt()` that
 * cannot be traced to one — which is why this is wired to a button and never
 * to an effect. The captured event is consumed either way: a dismissed dialog
 * cannot be reopened with the same event, and pretending otherwise would leave
 * a button that throws.
 *
 * Every path out of here leaves the surface *visible*. Clearing `pending`
 * without settling one of the other flags would drop the state back to
 * `unavailable`, which is the one value that renders nothing at all — so the
 * section the reader was pressing would disappear under their finger.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = store.pending;
  if (!event) return "unknown";
  // Consumed synchronously, before the first await. Two overlapping calls —
  // a double press dispatched before React paints the disabled button, or a
  // second mount of the card — would otherwise both reach `prompt()` on
  // Chromium's single-use event, and the second rejection would report a
  // refusal for an install that succeeded.
  store.pending = null;
  // …and the surface is told the dialog is up, in the same synchronous beat.
  // `pending` alone carried "there is an offer"; emptying it without this
  // drops the state to `unavailable`, which renders nothing.
  store.prompting = true;
  announce();
  try {
    const choice = (await event.prompt()) ?? (await event.userChoice);
    store.prompting = false;
    if (choice?.outcome === "accepted") {
      // `appinstalled` normally follows and is what flips the state, but it is
      // not guaranteed on every platform — so record it here too rather than
      // waiting for an event that may never arrive. Without this the whole
      // surface collapses to `unavailable` at the moment the install worked.
      //
      // Persistence is deliberately *not* requested here: the origin is not an
      // installed app yet, so the browser would refuse and the one attempt
      // this page load gets would be gone. `appinstalled` asks, and the card's
      // own effect asks on any road that never fires it.
      store.installedNow = true;
      announce();
      return "accepted";
    }
    // Anything that is not a readable "accepted" is spent, so the offer is
    // over either way. `declined` keeps the surface on screen; the copy it
    // renders deliberately does not assert what happened, because an
    // unreadable outcome (older Chromium resolved `prompt()` with nothing) is
    // genuinely unknown — and telling someone who just installed the app that
    // nothing was installed is worse than saying nothing about it.
    store.declined = true;
    announce();
    return choice?.outcome === "dismissed" ? "dismissed" : "unknown";
  } catch (error) {
    // `NotAllowedError` means Chromium would not trace the call to a transient
    // user activation. The event is NOT consumed in that case, so keeping it
    // leaves the button on screen and a proper press works. Throwing it away
    // would tell the reader to go and find the browser's own menu when a
    // second tap would have done.
    store.prompting = false;
    // Read the shape, not the constructor: a cross-realm rejection, a wrapped
    // one, or an engine that rejects with a plain Error still means the same
    // thing, and misreading it would retire an offer the browser never spent.
    const named: { name?: string } = overlapCast(error ?? {});
    if (named.name === "NotAllowedError") {
      // Chromium did not consume it, so hand it back: the button stays live
      // and a properly-traced press works.
      store.pending ??= event;
      announce();
      return "retry";
    }
    // Anything else — a genuinely spent event — is gone, but the reader is
    // still looking at the card, so land somewhere that still renders.
    store.declined = true;
    announce();
    return "unknown";
  }
}

/** Test seam: forget everything this module has captured. */
export function resetInstallForTest(): void {
  if (globalThis.window !== undefined) {
    if (store.onBeforePrompt) {
      window.removeEventListener("beforeinstallprompt", store.onBeforePrompt);
    }
    if (store.onInstalled) {
      window.removeEventListener("appinstalled", store.onInstalled);
    }
    if (store.query && store.onDisplayMode) {
      store.query.removeEventListener?.("change", store.onDisplayMode);
    }
  }
  // Replaced wholesale rather than cleared field by field, so a flag added to
  // `InstallStore` cannot be forgotten here.
  store = freshStore();
  listeners.clear();
}
