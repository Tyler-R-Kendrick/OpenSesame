import {
  listNotices,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { useSyncExternalStore } from "react";
import { NotificationsBar } from "./NotificationsBar.js";

/** Bell for shellless screens; latest claim/drop failure paints in `data-c`. */
export function NoticeCorner() {
  const n = useSyncExternalStore(subscribeNotices, listNotices);
  if (!n.length) return null;
  const l = n[n.length - 1];
  return (
    <div
      className="notice-corner"
      data-c={
        l.id.startsWith("identity.claim.")
          ? `${l.title} - ${l.body}`
          : undefined
      }
    >
      <NotificationsBar />
    </div>
  );
}
