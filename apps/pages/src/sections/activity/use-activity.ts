/**
 * React bindings for the activity listing: the sealed events, read when a
 * reader mounts (the page, or the rail subtree once it is opened) and again
 * on every append; and the shared search/page state.
 */

import {
  type ActivityEvent,
  listActivityEvents,
  subscribeActivity,
} from "@opensesame/app-core/lib/activity-log.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type ActivityListing,
  activityListing,
  subscribeActivityListing,
} from "./activity-listing.js";

export type ActivityEvents = Readonly<{
  /** The unlocked tomb, or null while locked. */
  tomb: string | null;
  /** Null until the first read for this tomb lands. */
  events: ActivityEvent[] | null;
  busy: boolean;
  refresh: () => Promise<void>;
}>;

/** A read's result, kept with the tomb it was read from. */
type Read = Readonly<{ tomb: string | null; events: ActivityEvent[] }>;

export function useActivityEvents(): ActivityEvents {
  const { status, tomb } = useVault();
  const open = status === "unlocked" && tomb ? tomb : null;
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest read may land: one still in flight when the vault
  // switched (or when a later append re-read) is dropped, so another
  // vault's events never overwrite this one's.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    if (!open) {
      setRead({ tomb: null, events: [] });
      setBusy(false);
      return;
    }
    setBusy(true);
    let events: ActivityEvent[] = [];
    try {
      events = await listActivityEvents(open);
    } catch {
      events = [];
    }
    if (mine !== latest.current) return;
    setRead({ tomb: open, events });
    setBusy(false);
  }, [open]);

  useEffect(() => {
    void refresh();
    return subscribeActivity(() => {
      void refresh();
    });
  }, [refresh]);

  // A read from the vault before this one is not this vault's log.
  const events = read && read.tomb === open ? read.events : null;
  return { tomb: open, events, busy, refresh };
}

export function useActivityListing(tomb: string | null): ActivityListing {
  const read = useCallback(() => activityListing(tomb), [tomb]);
  return useSyncExternalStore(subscribeActivityListing, read, read);
}
