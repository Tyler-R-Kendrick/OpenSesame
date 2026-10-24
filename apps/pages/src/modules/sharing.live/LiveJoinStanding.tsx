import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import { CONNECTING_TIMEOUT_MS } from "@opensesame/app-core/lib/live/guest.js";
import { iceStatusLabel } from "@opensesame/app-core/lib/live/ice-diagnostics.js";
import { reportLiveOutcome } from "@opensesame/app-core/lib/live/outcome-notices.js";
import { leaveLive } from "@opensesame/app-core/lib/live/session.js";
import { useEffect, useState } from "react";
import { IconArrowRight } from "../../components/Icons.js";
import type { Standing } from "./live-hooks.js";

/** The glyph and sentence for where an ask stands. */
export function standing(status: GuestStatus): Standing {
  switch (status.at) {
    case "preparing":
      return {
        tone: "idle",
        label: "Making your request code",
        tray: "Making your request code",
      };
    case "request":
      return {
        tone: "idle",
        label: "Waiting for the owner's reply code",
        tray: "Waiting for the owner's reply code",
      };
    case "addresses":
      return {
        tone: "idle",
        label: "The owner's browser names its addresses",
        tray: "Allow the owner's addresses, or join without them",
      };
    case "connecting": {
      const detail = status.ice ? iceStatusLabel(status.ice) : "Connecting";
      return {
        tone: "idle",
        label: "Connecting to the owner's browser",
        tray: detail,
      };
    }
    case "connect_timeout":
      return {
        tone: "err",
        label: "Connection timed out",
        tray: "Connection timed out — ask again, or check your network",
      };
    case "joined":
      return {
        tone: "ok",
        label: `Joined ${status.catalog.title}`,
        tray: `Joined ${status.catalog.title}`,
      };
    case "unreachable":
      return {
        tone: "err",
        label: "No route to the owner's browser",
        tray: status.reason,
      };
    default:
      return {
        tone: "idle",
        label: "The session ended",
        tray: "The session ended",
      };
  }
}

export function ConnectingProgress({
  guest,
  status,
}: {
  guest: LiveGuest;
  status: Extract<GuestStatus, { at: "connecting" }>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - status.since) / 1000));
  const limit = Math.floor(CONNECTING_TIMEOUT_MS / 1000);
  const iceLine = status.ice ? iceStatusLabel(status.ice) : "Checking a route";
  return (
    <>
      <p className="vault-row__meta" data-testid="live-join-ice">
        {iceLine} · {elapsed}s / {limit}s
      </p>
      <div className="go-row" id="live-start-over">
        <button
          type="button"
          className="go"
          aria-label="Start over"
          title="Start over"
          onClick={() => {
            leaveLive();
            reportLiveOutcome("Live session", "Connecting ended");
          }}
        >
          <IconArrowRight size={18} />
        </button>
        <span className="go-verb" aria-hidden="true">
          Start over
        </span>
      </div>
    </>
  );
}
