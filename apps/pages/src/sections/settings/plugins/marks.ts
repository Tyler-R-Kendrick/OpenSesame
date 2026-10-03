/**
 * The one mark a plugin tile wears: a glyph whose sentence is its label
 * (DESIGN.md § Status is a symbol). Pure, so every state is testable
 * without drawing anything.
 */

import type { PluginErrorCode } from "@opensesame/app-core/lib/plugins/client.js";
import type { PluginView } from "@opensesame/app-core/lib/plugins/session.js";
import { standingOf } from "@opensesame/app-core/lib/plugins/wire.js";
import type { StatusTone } from "../../../components/StatusMark.js";

export type PluginMark = Readonly<{ tone: StatusTone; label: string }>;

const ERRORS = {
  "no-daemon": "No daemon paired",
  unreachable: "The daemon did not answer",
  unauthorized: "The daemon did not let this device in",
  malformed: "The daemon's answer was unreadable",
  "not-installed": "Not installed",
  "forced-off": "Forced off on the daemon",
  "unknown-plugin": "The daemon does not know this plugin",
  "pin-mismatch": "Changed since it was installed",
  "not-a-code": "Not a plugin pairing code",
  "other-origin": "That code is for another page",
  "pairing-refused": "The daemon would not take that code",
  locked: "Unlock the vault to pair",
  refused: "The daemon refused",
} as const satisfies Readonly<Record<PluginErrorCode, string>>;

export function markOf(view: PluginView): PluginMark {
  if (view.daemon === null) {
    return view.error === null
      ? { tone: "idle", label: ERRORS["no-daemon"] }
      : { tone: "err", label: ERRORS[view.error] };
  }
  if (view.error !== null && view.state === null)
    return { tone: "err", label: ERRORS[view.error] };
  if (view.state === null) {
    return view.read
      ? { tone: "idle", label: ERRORS["not-installed"] }
      : { tone: "idle", label: "Asking the daemon" };
  }
  // A switch that did not take says so in place of the standing it kept.
  if (view.error !== null) return { tone: "err", label: ERRORS[view.error] };
  switch (standingOf(view.state)) {
    case "not-installed":
      return { tone: "idle", label: ERRORS["not-installed"] };
    case "forced-off":
      return { tone: "warn", label: ERRORS["forced-off"] };
    case "on":
      return { tone: "ok", label: "On" };
    default:
      return { tone: "idle", label: "Installed, off" };
  }
}
