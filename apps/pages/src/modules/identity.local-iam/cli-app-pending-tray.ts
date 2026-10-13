/**
 * Tray doorbell while the daemon waits for CLI integration approval (ADR 0186).
 */

import {
  CLI_AUTHORIZE_ROUTE,
  fetchFirstCliAppPending,
} from "@opensesame/app-core/lib/cli-app-integration/client.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { pageIsLoopback } from "@opensesame/app-core/lib/settings.js";
import gate from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};

export const CLI_APP_PENDING_NOTICE = "identity:cli-app-pending";

let timer: ReturnType<typeof setInterval> | undefined;

async function poll(): Promise<void> {
  if (!pageIsLoopback()) {
    dismissNotice(CLI_APP_PENDING_NOTICE);
    return;
  }
  const row = await fetchFirstCliAppPending();
  if (!row) {
    dismissNotice(CLI_APP_PENDING_NOTICE);
    return;
  }
  setStatusNotice({
    id: CLI_APP_PENDING_NOTICE,
    tone: "warn",
    title: gate.ui.sheetTitle,
    body: gate.messages.pending,
    open: { to: CLI_AUTHORIZE_ROUTE, label: gate.ui.allowKey },
  });
}

/** Poll the daemon for pending CLI requests until `stop` runs. */
export function startCliAppPendingTrayWatch(): () => void {
  if (timer !== undefined) return () => undefined;
  void poll();
  timer = setInterval(() => {
    void poll();
  }, gate.pollIntervalMs);
  return () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    dismissNotice(CLI_APP_PENDING_NOTICE);
  };
}

/** Tests only. */
export function resetCliAppPendingTrayWatchForTests(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  dismissNotice(CLI_APP_PENDING_NOTICE);
}
