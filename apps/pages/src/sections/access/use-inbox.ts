import {
  type InboxRow,
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
 * and the moment the soonest waiting request lapses. `read` is the inbox's
 * reader, there so a test can hand the hook one it controls.
 */
export function useInboxCount(
  tomb: string,
  read: (tomb: string) => Promise<readonly InboxRow[]> = listInbox,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reread = () => {
      clearTimeout(timer);
      read(tomb).then(
        (rows) => {
          if (!live) return;
          setCount(rows.length);
          const next = Math.min(...rows.map((r) => Date.parse(r.expiresAt)));
          if (Number.isFinite(next))
            timer = setTimeout(reread, Math.max(0, next - Date.now()) + 50);
        },
        () => {
          if (live) setCount(0);
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
