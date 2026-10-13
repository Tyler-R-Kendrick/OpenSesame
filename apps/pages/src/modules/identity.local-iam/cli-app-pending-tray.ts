/**
 * Tray doorbell while the daemon waits for CLI integration approval (ADR 0186).
 */

import { fetchDaemonCliPending } from "./cli-daemon-pending-fetch.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { pageIsLoopback } from "@opensesame/app-core/lib/settings.js";
import {
  CLI_AUTHORIZE_ROUTE,
  readCliAppAuthHeaders,
  readDaemonOrigin,
} from "./cli-authorize-session.js";

export const CLI_APP_PENDING_NOTICE = "identity:cli-app-pending";

const POLL_MS = 500;
const TRAY_TITLE = "Authorize CLI";
const TRAY_BODY = "Allow CLI integration in OpenSesame.";
const TRAY_OPEN_LABEL = "Authorize";

let timer: ReturnType<typeof setInterval> | undefined;

async function poll(): Promise<void> {
  if (!pageIsLoopback()) {
    dismissNotice(CLI_APP_PENDING_NOTICE);
    return;
  }
  const headers = readCliAppAuthHeaders();
  if (!readDaemonOrigin() || !headers) {
    dismissNotice(CLI_APP_PENDING_NOTICE);
    return;
  }
  try {
    const row = await fetchDaemonCliPending(readDaemonOrigin() ?? "", headers);
    if (!row) {
      dismissNotice(CLI_APP_PENDING_NOTICE);
      return;
    }
    setStatusNotice({
      id: CLI_APP_PENDING_NOTICE,
      tone: "warn",
      title: TRAY_TITLE,
      body: TRAY_BODY,
      open: {
        to: CLI_AUTHORIZE_ROUTE,
        label: TRAY_OPEN_LABEL,
      },
    });
  } catch {
    dismissNotice(CLI_APP_PENDING_NOTICE);
  }
}

/** Poll the daemon for pending CLI requests until `stop` runs. */
export function startCliAppPendingTrayWatch(): () => void {
  if (timer !== undefined) return () => undefined;
  void poll();
  timer = setInterval(() => {
    void poll();
  }, POLL_MS);
  return () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    dismissNotice(CLI_APP_PENDING_NOTICE);
  };
}

/** @internal test seam */
export function resetCliAppPendingTrayWatchForTests(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}
