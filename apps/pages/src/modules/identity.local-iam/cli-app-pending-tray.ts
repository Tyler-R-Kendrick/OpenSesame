/**
 * Tray doorbell while the daemon waits for CLI integration approval (ADR 0186).
 */

import { fetchFirstCliAppPending } from "@opensesame/app-core/lib/cli-app-integration/client.js";
import { cliAppIntegrationUi } from "@opensesame/app-core/lib/cli-app-integration/policy-ui.js";
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
    const row = await fetchFirstCliAppPending(readDaemonOrigin() ?? "", headers);
    if (!row) {
      dismissNotice(CLI_APP_PENDING_NOTICE);
      return;
    }
    setStatusNotice({
      id: CLI_APP_PENDING_NOTICE,
      tone: "warn",
      title: cliAppIntegrationUi.sheetTitle,
      body: cliAppIntegrationUi.messages.pending,
      open: {
        to: CLI_AUTHORIZE_ROUTE,
        label: cliAppIntegrationUi.allowKey,
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
  }, cliAppIntegrationUi.pollIntervalMs);
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
