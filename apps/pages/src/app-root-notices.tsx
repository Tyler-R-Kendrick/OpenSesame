import { ClaimDropAnnouncement } from "./components/ClaimDropAnnouncement.js";
import { NoticeCorner } from "./components/NoticeCorner.js";

/** Tray chrome for screens that carry their own bell (shellless routes). */
export function AppRootNotices({ shellless }: { shellless: boolean }) {
  return (
    <>
      <ClaimDropAnnouncement />
      {shellless ? <NoticeCorner /> : null}
    </>
  );
}
