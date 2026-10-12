/**
 * Closed set of actions the command bar may run. The model picks among these.
 *
 * Plain types here, on purpose: this module is on the first-paint path (the
 * shell imports the command bar), and the zod schema that validates a model's
 * answer lives in `schema.ts` behind the same lazy import as the AI SDK, so a
 * vault that never speaks to a model never downloads either.
 */

import { isCapabilityDenied } from "../capabilities/runtime-contract.js";
import {
  assertNavigationContribution,
  contributionsSnapshot,
} from "../contributions.js";

/**
 * The destinations the core shell can always open. Every other one is a
 * `command-path` contribution from the capability that owns the route, so a
 * command for an excluded capability has nowhere to go (SURFACE-09).
 *
 * These mirror the rail. The claim ceremony is always-on and is not a rail
 * section, so it is `CLAIM_COMMAND_PATH` rather than one of these.
 */
export const COMMAND_SECTIONS = ["/vault", "/settings"] as const;

/** `/claim`: paste a claim or drop. Always-on, not a rail row. */
export const CLAIM_COMMAND_PATH = "/claim";

/**
 * `/join`: the same road as the front door's Join a session. Always-on, not
 * a rail row, and not gated on a setup record — a device that already holds
 * a vault can still open it.
 */
export const JOIN_COMMAND_PATH = "/join";

/** Core destinations, claim, join, and every registered `command-path`. */
export function commandSections(): readonly string[] {
  const paths: string[] = [
    ...COMMAND_SECTIONS,
    CLAIM_COMMAND_PATH,
    JOIN_COMMAND_PATH,
  ];
  for (const entry of contributionsSnapshot("command-path")) {
    if (!paths.includes(entry.path)) paths.push(entry.path);
  }
  return paths;
}

export function isCommandSection(path: string): boolean {
  return commandSections().includes(path);
}

/**
 * The dispatch gate for a destination (ownership.md §4.2): a core section
 * always opens; a contributed one only while the capability that registered
 * it is approved under a current lease. The command bar and the WebMCP
 * navigation tool ask this before they move, not just whether it is listed.
 */
export function commandPathAuthorized(path: string): boolean {
  if (path === CLAIM_COMMAND_PATH || path === JOIN_COMMAND_PATH) return true;
  if (COMMAND_SECTIONS.some((core) => core === path)) return true;
  try {
    assertNavigationContribution(
      "command-path",
      (entry) => entry.path === path,
    );
    return true;
  } catch (error) {
    if (isCapabilityDenied(error)) return false;
    throw error;
  }
}

/** `rest` is the part of a password that follows the person's own pepper (ADR 0174). */
export const COMMAND_FIELDS = [
  "password",
  "rest",
  "username",
  "otp",
  "url",
] as const;

export type CommandSection = string;
export type CommandField = (typeof COMMAND_FIELDS)[number];

export type AppCommand =
  | { action: "navigate"; path: CommandSection }
  /** Display name fragment to match against vault items. Never a secret. */
  | { action: "open_item"; query: string }
  | { action: "copy_field"; query: string; field: CommandField }
  | { action: "search"; query: string }
  | { action: "help" }
  /** A configuration document from the palette registry, by its route. */
  | { action: "open_path"; path: string; label: string }
  /** A path the registry refuses to open, with the reason to show. */
  | { action: "refuse"; message: string };

/** A reading of an utterance: a command, or why there is none. */
export type InterpretResult =
  | { source: "parse" | "model"; command: AppCommand }
  | { source: "none"; reason: string };

export type CommandOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };
