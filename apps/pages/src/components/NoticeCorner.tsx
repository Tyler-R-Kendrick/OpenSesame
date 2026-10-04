import {
  listNotices,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { useSyncExternalStore } from "react";
import { NotificationsBar } from "./NotificationsBar.js";

/**
 * The bell for a screen that has no shell: the unlock screen, the front door,
 * the federated return and an unframed popup. A failure is a notice in the
 * tray and never a box in the page (DESIGN.md § Status is a symbol), so a
 * screen drawn before unlock still needs somewhere to read it. It appears
 * when the tray holds something and is absent otherwise; the unlocked shell
 * carries its own bell and does not mount this.
 */
export function NoticeCorner() {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  if (notices.length === 0) return null;
  return (
    <div className="notice-corner">
      <NotificationsBar />
    </div>
  );
}
