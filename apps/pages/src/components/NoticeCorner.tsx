import {
  listNotices,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { useSyncExternalStore } from "react";
import { NotificationsBar, StatusNoticeCard } from "./NotificationsBar.js";

/**
 * The bell for a screen that has no shell: the unlock screen, the front door,
 * the federated return and an unframed popup. A failure is a notice in the
 * tray and never a box in the page (DESIGN.md § Status is a symbol), so a
 * screen drawn before unlock still needs somewhere to read it. It appears
 * when the tray holds something and is absent otherwise; the unlocked shell
 * carries its own bell and does not mount this.
 *
 * It is a block in the document flow, right-aligned above the screen body —
 * never an overlay — so it cannot rest on a control such as the front door's
 * Skip.
 *
 * A failure here must not read as a no-op: the freshest err notice's card is
 * on screen beside the bell, so the sentence that explains why nothing
 * happened is visible the moment it lands. It is the tray's own card, not a
 * box in the page — and not the sheet either, which would take the caret out
 * of a field mid-ceremony.
 */
export function NoticeCorner() {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  if (notices.length === 0) return null;
  const freshestErr = [...notices]
    .reverse()
    .find((notice) => notice.kind === "status" && notice.tone === "err");
  return (
    <div className="notice-corner">
      {freshestErr ? (
        <StatusNoticeCard notice={freshestErr} onOpen={() => undefined} />
      ) : null}
      <NotificationsBar />
    </div>
  );
}
