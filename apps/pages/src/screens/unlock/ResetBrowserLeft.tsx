/**
 * What a reset left behind, one row per area: a glyph for why (it would not
 * go, or it was kept on purpose while the network does not answer) and the
 * area's name. The sentence is the glyph's name (DESIGN.md § Status is a
 * symbol); nothing here explains.
 */

import type {
  BrowserResetArea,
  BrowserResetReport,
} from "@opensesame/app-core/lib/browser-reset.js";
import { StatusMark } from "../../components/StatusMark.js";

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

/** Anything left at all: a clean reset has nothing to show. */
export function leftBehind(report: BrowserResetReport): boolean {
  return report.failed.length > 0 || report.kept.length > 0;
}

export function ResetBrowserLeft({ report }: { report: BrowserResetReport }) {
  return (
    <ul className="unlock__left" aria-label="Still in this browser">
      {report.failed.map((area) => (
        <li key={area}>
          <StatusMark tone="err" label={`${NAMES[area]}: not erased`} />
          <span>{NAMES[area]}</span>
        </li>
      ))}
      {report.kept.map((area) => (
        <li key={area}>
          <StatusMark tone="warn" label={`${NAMES[area]}: ${keptWhy(area)}`} />
          <span>{NAMES[area]}</span>
        </li>
      ))}
    </ul>
  );
}
