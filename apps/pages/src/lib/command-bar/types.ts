/**
 * Closed set of actions the command bar may run. The model picks among these.
 *
 * Plain types here, on purpose: this module is on the first-paint path (the
 * shell imports the command bar), and the zod schema that validates a model's
 * answer lives in `schema.ts` behind the same lazy import as the AI SDK, so a
 * vault that never speaks to a model never downloads either.
 */

import { contributionsSnapshot } from "../contributions.js";

/**
 * The destinations the core shell can always open. Every other one is a
 * `command-path` contribution from the capability that owns the route, so a
 * command for an excluded capability has nowhere to go (SURFACE-09).
 */
export const COMMAND_SECTIONS = ["/vault", "/settings"] as const;

/** Core destinations plus every registered `command-path`, deduplicated. */
export function commandSections(): readonly string[] {
  const paths: string[] = [...COMMAND_SECTIONS];
  for (const entry of contributionsSnapshot("command-path")) {
    if (!paths.includes(entry.path)) paths.push(entry.path);
  }
  return paths;
}

export function isCommandSection(path: string): boolean {
  return commandSections().includes(path);
}

export const COMMAND_FIELDS = ["password", "username", "otp", "url"] as const;

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

export type CommandOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };
