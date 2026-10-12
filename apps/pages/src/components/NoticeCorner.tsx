import {
  listNotices,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { useSyncExternalStore } from "react";
import { NotificationsBar, StatusNoticeCard } from "./NotificationsBar.js";

/**
 * Bell for shellless screens; latest claim/drop failure paints in `data-c`.
 * A fresh failure's card sits beside the bell, so the sentence that explains
 * why nothing happened is visible the moment it lands — not the sheet, which
 * would take the caret out of a field mid-ceremony.
 */
export function NoticeCorner() {
  const n = useSyncExternalStore(subscribeNotices, listNotices);
  if (!n.length) return null;
  const l = n[n.length - 1];
  const freshestErr = [...n]
    .reverse()
    .find((notice) => notice.kind === "status" && notice.tone === "err");
  return (
    <div
      className="notice-corner"
      data-c={
        l.id.startsWith("identity.claim.")
          ? `${l.title} - ${l.body}`
          : undefined
      }
    >
      {freshestErr ? (
        <StatusNoticeCard notice={freshestErr} onOpen={() => undefined} />
      ) : null}
      <NotificationsBar />
    </div>
  );
}
