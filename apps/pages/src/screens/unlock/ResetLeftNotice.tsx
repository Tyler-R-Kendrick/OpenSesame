/**
 * What the last reset left behind, first on the lock screen the fresh
 * document opens on: one row per area, a glyph for why (it would not go, or
 * it was kept on purpose while the network did not answer) and the area's
 * name. The sentence is the glyph's name (DESIGN.md § Status is a symbol);
 * nothing here explains. Two keys: erase again, or dismiss.
 */

import {
  dismissLandingReset,
  landingLeftBehind,
  onLandingResetChange,
} from "@opensesame/app-core/lib/browser-reset-landing.js";
import type { BrowserResetArea } from "@opensesame/app-core/lib/browser-reset.js";
import { useSyncExternalStore } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { eraseAndLeave } from "./reset-browser-run.js";

const NAMES = {
  session: "Sign-in",
  origin_files: "Vaults and settings",
  databases: "History backups",
  web_storage: "Sign-in records",
  push_subscription: "Notifications",
  caches: "Offline app",
  service_workers: "Offline worker",
} as const satisfies Record<BrowserResetArea, string>;

function keptWhy(area: BrowserResetArea): string {
  return area === "push_subscription"
    ? "still subscribed"
    : "kept while offline";
}

export function ResetLeftNotice() {
  const left = useSyncExternalStore(onLandingResetChange, landingLeftBehind);
  // Raised before the early return so dismissing the row clears the notice.
  useFailureNotice(
    "unlock:reset-left",
    "Browser reset",
    left?.failed.length
      ? `${left.failed.map((area) => NAMES[area]).join(", ")}: not erased`
      : null,
  );
  if (!left) return null;
  return (
    <fieldset className="unlock__danger" aria-label="Reset this browser">
      <ul className="unlock__left" aria-label="Still in this browser">
        {left.failed.map((area) => (
          <li key={area}>
            <StatusMark tone="err" label={`${NAMES[area]}: not erased`} />
            <span>{NAMES[area]}</span>
          </li>
        ))}
        {left.kept.map((area) => (
          <li key={area}>
            <StatusMark
              tone="warn"
              label={`${NAMES[area]}: ${keptWhy(area)}`}
            />
            <span>{NAMES[area]}</span>
          </li>
        ))}
      </ul>
      <div className="actions">
        <IconKey label="Erase again" onClick={() => void eraseAndLeave()}>
          <IconRefresh size={16} />
        </IconKey>
        <IconKey label="Dismiss" small onClick={dismissLandingReset}>
          <IconX size={16} />
        </IconKey>
      </div>
    </fieldset>
  );
}
