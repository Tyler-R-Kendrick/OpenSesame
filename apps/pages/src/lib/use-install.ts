import { useSyncExternalStore } from "react";
import {
  type InstallOutcome,
  type InstallState,
  installPersisted,
  installState,
  installWorthShowing,
  promptInstall,
  subscribeInstall,
} from "./install.js";

export type InstallView = {
  state: InstallState;
  /** Whether the install surface should render at all on this browser. */
  visible: boolean;
  /** Whether the browser has agreed to keep this origin's storage. */
  persisted: boolean;
  /** Open the browser's install dialog. Must run inside a user gesture. */
  install: () => Promise<InstallOutcome>;
};

/**
 * Test seam — **data, never the hook itself**.
 *
 * Swapping the hook out for a stub would mean the real and stubbed versions
 * call different numbers of hooks, so reassigning it while a consumer is
 * mounted throws "Rendered fewer hooks than during the previous render" — with
 * nothing pointing at the seam. Driving one state transition inside a single
 * test is the obvious thing to want, and that is exactly what would break.
 * Overriding the *values* keeps one code path with one hook count.
 */
export type InstallViewOverrides = {
  /** The state the hook reports; null lets the real store through. */
  state: InstallState | null;
  /** The persistence answer; null lets the real store through. */
  persisted: boolean | null;
  /** The action the card invokes; null uses the real `promptInstall`. */
  install: (() => Promise<InstallOutcome>) | null;
};

export const installViewSeams: InstallViewOverrides = {
  state: null,
  persisted: null,
  install: null,
};

/** No browser to ask — a server render or a prerender — so nothing to offer. */
const serverSnapshot: () => InstallState = () => "unavailable";
const serverPersisted: () => boolean = () => false;

/**
 * Where installing stands, as a component sees it.
 *
 * A hook rather than a prop drilled from the app root because the answer
 * changes on the browser's schedule, not the app's: `beforeinstallprompt` can
 * land seconds after the page does, and `appinstalled` can land while a
 * completely different screen is open.
 *
 * `useSyncExternalStore` rather than useState + useEffect, for two reasons that
 * both bite in production and neither in a test. It re-reads the store at
 * subscribe time, so an event landing between render and the passive effect —
 * exactly when Chromium fires on a fast load — is not lost; and it keeps every
 * consumer on one value, so the ceremony's heading can never disagree with the
 * card underneath it about whether there is an install to offer.
 */
export function useInstall(): InstallView {
  const live = useSyncExternalStore(
    subscribeInstall,
    installState,
    serverSnapshot,
  );
  // A second subscription rather than a composite snapshot: both are cheap
  // primitives, and the grant lands asynchronously long after the state does,
  // so the card has to re-render on it.
  const livePersisted = useSyncExternalStore(
    subscribeInstall,
    installPersisted,
    serverPersisted,
  );
  const state = installViewSeams.state ?? live;
  return {
    state,
    visible: installWorthShowing(state),
    persisted: installViewSeams.persisted ?? livePersisted,
    install: installViewSeams.install ?? promptInstall,
  };
}
