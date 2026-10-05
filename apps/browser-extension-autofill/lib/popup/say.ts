/**
 * The popup's words for an outcome code. They reach the page only as a
 * status mark's `aria-label` and `title` (docs/design/controls.md §3), never
 * as a paragraph, and never carry a value.
 */
import type { Outcome } from "../fill/protocol";

export type Tone = "ok" | "warn" | "off";

const HIDDEN_FIELD = "The field is not visible, so nothing was filled";

const SAY = new Map<string, string>(
  Object.entries({
    filled: "Filled",
    ready: "Ready",
    site_off: "Autofill is off on this site",
    plugin_off: "The autofill plugin is off on this computer",
    permission_not_granted: "The browser did not grant this site",
    passkey_offered: "This page offers a passkey. Use it instead",
    choose_in_popup: "More than one entry matches. Choose one",
    no_match: "No entry is stored for this exact origin",
    no_page: "This tab has no web page to fill",
    not_paired: "Not paired with this computer yet",
    no_focused_field: "Focus a username or password field first",
    not_a_login_field:
      "The focused field is not a username or current password",
    not_top_frame:
      "Only fields in the page itself are filled, never in a frame",
    origin_mismatch: "The page changed, so nothing was filled",
    focus_moved: "Focus moved, so nothing was filled",
    covered: HIDDEN_FIELD,
    transparent: HIDDEN_FIELD,
    hidden: HIDDEN_FIELD,
    off_screen: HIDDEN_FIELD,
    zero_size: HIDDEN_FIELD,
    needs_pepper:
      "This password needs a pepper. Open it in the vault to use it",
    store_locked: "The store on this computer is locked",
    daemon_unreachable: "Nothing answers on this computer",
    rate_limited: "Too many fills. Wait a moment",
    guard_unavailable: "This page cannot be filled",
  }),
);

const OK = new Set(["filled", "ready"]);

/** A person-readable line for an outcome code. */
export function describeOutcome(outcome: Outcome): string {
  return SAY.get(outcome) ?? outcome.replaceAll("_", " ");
}

export function toneOf(outcome: Outcome): Tone {
  if (OK.has(outcome)) return "ok";
  return outcome === "site_off" || outcome === "plugin_off" ? "off" : "warn";
}
