import {
  type InboxRow,
  READ_RETRY_DELAYS_MS,
  listInbox,
} from "@opensesame/app-core/lib/device-inbox.js";
import {
  subscribeLocalIamChanges,
  subscribeLocalIamChangesFromOtherTabs,
} from "@opensesame/app-core/lib/local-iam-events.js";
import { useEffect, useState } from "react";

/**
 * How many requests wait for the person who holds this vault, or zero while
 * that cannot be read (a locked vault, an unreadable ledger): a count the page
 * cannot stand behind is not drawn. It follows what changes it — a request
 * raised or decided here or in another tab, the window coming back into focus,
 * and the moment the soonest waiting request lapses. A read that fails is
 * tried again a few times, later each time. Only the newest read counts: one
 * that was overtaken by another neither sets the count nor leaves a timer.
 * `read` is the inbox's reader, there so a test can hand the hook one it
 * controls.
 */
export function useInboxCount(
  tomb: string,
  read: (tomb: string) => Promise<readonly InboxRow[]> = listInbox,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let turn = 0;
    let failures = 0;
    const reread = () => {
      clearTimeout(timer);
      const mine = ++turn;
      read(tomb).then(
        (rows) => {
          if (!live || mine !== turn) return;
          failures = 0;
          setCount(rows.length);
          const next = Math.min(...rows.map((r) => Date.parse(r.expiresAt)));
          if (Number.isFinite(next))
            timer = setTimeout(reread, Math.max(0, next - Date.now()) + 50);
        },
        () => {
          if (!live || mine !== turn) return;
          setCount(0);
          const delay = READ_RETRY_DELAYS_MS[failures];
          failures += 1;
          if (delay !== undefined) timer = setTimeout(reread, delay);
        },
      );
    };
    reread();
    const here = subscribeLocalIamChanges(reread);
    const there = subscribeLocalIamChangesFromOtherTabs(reread);
    window.addEventListener("focus", reread);
    return () => {
      live = false;
      clearTimeout(timer);
      here();
      there();
      window.removeEventListener("focus", reread);
    };
  }, [tomb, read]);
  return count;
}
