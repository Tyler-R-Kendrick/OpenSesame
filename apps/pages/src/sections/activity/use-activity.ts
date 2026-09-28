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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type ActivityListing,
  activityListing,
  subscribeActivityListing,
} from "./activity-listing.js";

export type ActivityEvents = Readonly<{
  /** The unlocked tomb, or null while locked. */
  tomb: string | null;
  /** Null until the first read lands. */
  events: ActivityEvent[] | null;
  busy: boolean;
  refresh: () => Promise<void>;
}>;

export function useActivityEvents(): ActivityEvents {
  const { status, tomb } = useVault();
  const open = status === "unlocked" && tomb ? tomb : null;
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!open) {
      setEvents([]);
      return;
    }
    setBusy(true);
    try {
      setEvents(await listActivityEvents(open));
    } catch {
      setEvents([]);
    } finally {
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    void refresh();
    return subscribeActivity(() => {
      void refresh();
    });
  }, [refresh]);

  return { tomb: open, events, busy, refresh };
}

export function useActivityListing(tomb: string | null): ActivityListing {
  const read = useCallback(() => activityListing(tomb), [tomb]);
  return useSyncExternalStore(subscribeActivityListing, read, read);
}
