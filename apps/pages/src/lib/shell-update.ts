/**
 * What the shell says when a release is waiting on an edit, or the radio is down.
 * The sentence is a status mark and a tray notice — never a word on a key.
 */

import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";

export const SHELL_UPDATE_NOTICE_ID = "shell:update-ready";

export const UPDATE_READY_LABEL = "Update ready — Save, then reload";

/** The mark's accessible name, or null when the shell has nothing to say. */
export function shellPresenceLabel(input: {
  offline: boolean;
  updateReady: boolean;
}): string | null {
  if (input.offline && input.updateReady) {
    return `Offline. ${UPDATE_READY_LABEL}`;
  }
  if (input.updateReady) return UPDATE_READY_LABEL;
  if (input.offline) return "Offline";
  return null;
}

/** Mirror a waiting release into the tray, and take it down when it is gone. */
export function syncShellUpdateNotice(updateReady: boolean): void {
  if (!updateReady) {
    dismissNotice(SHELL_UPDATE_NOTICE_ID);
    return;
  }
  setStatusNotice({
    id: SHELL_UPDATE_NOTICE_ID,
    tone: "warn",
    title: "Update ready",
    body: "Save, then reload.",
  });
}
