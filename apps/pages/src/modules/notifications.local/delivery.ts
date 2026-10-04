/**
 * The browser's half of local notifications (ADR 0162): the three places a
 * notice rings, and the signals that make the inbox be read again. Everything
 * here is on this device. Nothing opens a connection, registers a push
 * subscription or asks a service to deliver anything.
 *
 * Side effects: none at import, and none until a function here is called by
 * the watcher the capability starts. In particular nothing here asks the
 * browser for the `notifications` permission: that is the panel's key, and
 * only when it is pressed.
 */

import {
  subscribeLocalIamChanges,
  subscribeLocalIamChangesFromOtherTabs,
} from "@opensesame/app-core/lib/local-iam-events.js";
import type { LocalEnvironment } from "@opensesame/app-core/lib/local-notifications/destinations.js";
import {
  NOTICE_ROUTE,
  noticeWords,
  parseNotice,
} from "@opensesame/app-core/lib/local-notifications/notice.js";
import { subscribePreference } from "@opensesame/app-core/lib/local-notifications/preference.js";
import type {
  Deliveries,
  WatchPorts,
  WatchTrigger,
} from "@opensesame/app-core/lib/local-notifications/watch.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";

/** The one tray notice, so a second request updates it rather than stacks. */
export const LOCAL_REQUESTS_NOTICE = "local-requests";

/** Replaces itself: a second request is the same doorbell, not another. */
export const SYSTEM_NOTIFICATION_TAG = "opensesame-local-request";

const MARK = /^\(\d+\) /;

/** There is a document whose title can carry a mark. */
export function hasDocument(): boolean {
  return globalThis.document !== undefined;
}

/** Whether a system notification could be asked for here at all. */
export function systemSupported(): boolean {
  return globalThis.Notification !== undefined;
}

/** What this browser offers, read now: permission can change under the page. */
export function readEnvironment(): LocalEnvironment {
  return {
    tabTitle: hasDocument(),
    system: systemSupported() ? Notification.permission : "unsupported",
  };
}

/** The tab's title and the app badge say how many wait; zero takes them down. */
function markTab(waiting: number): void {
  if (hasDocument()) {
    const bare = document.title.replace(MARK, "");
    document.title = waiting > 0 ? `(${waiting}) ${bare}` : bare;
  }
  // The Badging API exists only where the app is installed; elsewhere this is
  // the same mark in the title and nothing more.
  const badge = globalThis.navigator;
  const done =
    waiting > 0 ? badge?.setAppBadge?.(waiting) : badge?.clearAppBadge?.();
  done?.catch(() => undefined);
}

/**
 * The places a notice rings. `navigate` is the router's, which the click on a
 * system notification uses; it always goes to the list a request is decided
 * from and never to a decision.
 */
export function browserDeliveries(navigate: (to: string) => void): Deliveries {
  let showing: Notification | null = null;
  const close = () => {
    showing?.close();
    showing = null;
  };
  return {
    inApp(waiting) {
      if (waiting === null) {
        dismissNotice(LOCAL_REQUESTS_NOTICE);
        return;
      }
      const words = noticeWords(waiting);
      setStatusNotice({
        id: LOCAL_REQUESTS_NOTICE,
        tone: "warn",
        title: words.title,
        body: words.body,
        open: { to: NOTICE_ROUTE, label: "Review requests" },
      });
    },
    tabTitle: markTab,
    system(notice, waiting) {
      close();
      const words = noticeWords(waiting);
      try {
        const made = new Notification(words.title, {
          body: words.body,
          tag: SYSTEM_NOTIFICATION_TAG,
          // The contract and nothing else: a click reads it back through
          // `parseNotice`, so a field it did not write is not honored.
          data: notice,
        });
        made.onclick = () => {
          globalThis.focus();
          made.close();
          if (parseNotice(made.data) !== null) navigate(NOTICE_ROUTE);
        };
        showing = made;
      } catch {
        // A browser that will not construct one here (a phone's, which wants
        // a service worker) still has the bell and the tab's mark.
      }
    },
    closeSystem: close,
  };
}

/** Every signal that should make the inbox be read again. */
function subscribeSignals(trigger: (why: WatchTrigger) => void): () => void {
  const offs = [
    subscribeLocalIamChanges(() => trigger("change")),
    subscribeLocalIamChangesFromOtherTabs(() => trigger("other-tab")),
    subscribePreference(() => trigger("preference")),
  ];
  if (hasDocument()) {
    const seen = () => trigger("visible");
    document.addEventListener("visibilitychange", seen);
    globalThis.addEventListener("focus", seen);
    offs.push(() => {
      document.removeEventListener("visibilitychange", seen);
      globalThis.removeEventListener("focus", seen);
    });
  }
  return () => {
    for (const off of offs) off();
  };
}

/** The watcher's ports on this page, for the vault that is open. */
export function browserPorts(
  navigate: (to: string) => void,
  read: Pick<WatchPorts, "list" | "preference">,
): WatchPorts {
  return {
    list: read.list,
    preference: read.preference,
    environment: readEnvironment,
    hidden: () => hasDocument() && document.hidden,
    deliver: browserDeliveries(navigate),
    subscribe: subscribeSignals,
    now: () => Date.now(),
    later: (action, ms) => {
      const timer = setTimeout(action, ms);
      return () => clearTimeout(timer);
    },
  };
}
