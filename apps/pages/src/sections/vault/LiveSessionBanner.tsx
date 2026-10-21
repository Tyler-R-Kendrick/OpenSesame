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
    const read = () => {
      const status = currentGuest()?.status;
      setCount(status?.at === "joined" ? status.catalog.items.length : null);
    };
    read();
    return onLiveSessionChange(read);
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
