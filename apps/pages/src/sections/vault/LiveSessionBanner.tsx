/**
 * A joined live session inside the vault. The vault is the joiner's own; the
 * shared catalog stays live in this tab. This is the link between the two, so
 * a person who enters the vault can still see and reopen what the owner
 * shared.
 */

import {
  currentGuest,
  onLiveSessionChange,
} from "@opensesame/app-core/lib/live/session.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { StatusMark } from "../../components/StatusMark.js";

export function LiveSessionBanner() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let stopStatus = () => {};
    const listen = () => {
      stopStatus();
      const guest = currentGuest();
      if (!guest) {
        setCount(null);
        return;
      }
      const read = (
        status: NonNullable<ReturnType<typeof currentGuest>>["status"],
      ) =>
        setCount(status.at === "joined" ? status.catalog.items.length : null);
      read(guest.status);
      stopStatus = guest.subscribe(read);
    };
    listen();
    const stopSession = onLiveSessionChange(listen);
    return () => {
      stopStatus();
      stopSession();
    };
  }, []);
  if (count === null) return null;
  return (
    <div className="vault-live-banner" aria-label="Live session">
      <StatusMark tone="ok" label="In a live session" />
      <span>
        {count === 1 ? "1 shared item" : `${count} shared items`} from the
        owner's session.
      </span>
      <Link className="btn btn--sm" to="/live">
        Open shared items
      </Link>
    </div>
  );
}
