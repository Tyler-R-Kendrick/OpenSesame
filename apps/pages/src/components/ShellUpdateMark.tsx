/**
 * Offline, or a release waiting on an unsaved edit. A glyph in the rail and
 * the phone bar. The sentence is the accessible name (DESIGN.md § Status).
 */

import { useWorkerStatus } from "../bindings/capabilities.js";
import { useConnectivityMonitor } from "../bindings/connectivity-monitor.js";
import { shellPresenceLabel } from "../lib/shell-update.js";
import { StatusMark } from "./StatusMark.js";

export function ShellUpdateMark() {
  const offline = useConnectivityMonitor().offline;
  const updateReady = useWorkerStatus().updateReady;
  const label = shellPresenceLabel({ offline, updateReady });
  if (!label) return null;
  return (
    <span className="rail__presence">
      <StatusMark tone="warn" label={label} />
    </span>
  );
}
