/**
 * The companion's message names and outcome codes. There are exactly three
 * messages, each decoded in `wire.ts`:
 *
 * - `opensesame.fill` goes *to the background*. From the popup it carries
 *   `op: "status" | "trigger" | "enable" | "disable"` and never a value; from
 *   the guard it carries `op: "value"`, a nonce and a field name, and its
 *   reply is the one message in the whole flow that holds a value.
 * - `opensesame.fill.pair` goes from the popup to the background and asks
 *   the daemon for a pairing code (ADR 0052 §2 (b)).
 * - `opensesame.fill.arm` goes *from the background to frame 0* of the tab
 *   the person gestured on. It carries the nonce, the origin the background
 *   read from the tab, the trigger and the time; the guard's reply is an
 *   outcome code.
 */
import type { Refusal } from "./guard";

export const FILL_MESSAGE = "opensesame.fill";
export const PAIR_MESSAGE = "opensesame.fill.pair";
export const ARM_MESSAGE = "opensesame.fill.arm";

/** The manifest command bound to the fill gesture. */
export const FILL_COMMAND = "fill-focused-field";

/** The guard: registered per switched-on site, injected only as a fallback. */
export const GUARD_SCRIPT = "fill-guard.js";

/**
 * Why a fill did not happen, or that it did — never a value: `filled`, a
 * guard `Refusal`, an `AdmitRefusal`, a daemon refusal code, or one of
 * these flow outcomes.
 */
export type FlowOutcome =
  | "filled"
  | "focus_moved"
  | "no_value"
  | "no_page"
  | "no_match"
  | "site_off"
  | "plugin_off"
  | "choose_in_popup"
  | "guard_unavailable";
export type Outcome = FlowOutcome | Refusal | (string & {});
