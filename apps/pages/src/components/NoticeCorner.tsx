import { listNotices, subscribeNotices } from "@opensesame/app-core/lib/notices.js";
import { useSyncExternalStore } from "react";
import { NotificationsBar } from "./NotificationsBar.js";

const CLAIM_DROP_BAR_ID = "identity.claim.bar";

/**
 * The bell for a screen that has no shell: the unlock screen, the front door,
 * the federated return and an unframed popup. A failure is a notice in the
 * tray and never a box in the page (DESIGN.md § Status is a symbol), so a
 * screen drawn before unlock still needs somewhere to read it. It appears
 * when the tray holds something and is absent otherwise; the unlocked shell
 * carries its own bell and does not mount the tray here.
 *
 * A claim or drop failure may also raise a fixed top bar (tray history stays
 * in the bell); that bar is independent of `shellless`.
 */
export function NoticeCorner({ shellless = true }: { shellless?: boolean }) {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  const bar = notices.find((notice) => notice.id === CLAIM_DROP_BAR_ID);

  const showTray = notices.some((notice) => notice.id !== CLAIM_DROP_BAR_ID);
  if (!showTray && !(shellless && bar)) return null;

  return (
    <>
      {shellless && bar ? (
        <div className="claim-drop-bar" role="alert">
          <p className="claim-drop-bar__text">
            {bar.title} — {bar.body}
          </p>
        </div>
      ) : null}
      {showTray ? (
        <div className="notice-corner">
          <NotificationsBar />
        </div>
      ) : null}
    </>
  );
}
