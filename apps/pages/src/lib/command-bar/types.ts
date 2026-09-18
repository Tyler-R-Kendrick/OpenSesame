/**
 * Closed set of actions the command bar may run. The model picks among these.
 *
 * Plain types here, on purpose: this module is on the first-paint path (the
 * shell imports the command bar), and the zod schema that validates a model's
 * answer lives in `schema.ts` behind the same lazy import as the AI SDK, so a
 * vault that never speaks to a model never downloads either.
 */

export const COMMAND_SECTIONS = [
  "/vault",
  "/connections",
  "/access",
  "/identity",
  "/settings",
] as const;

export const COMMAND_FIELDS = ["password", "username", "otp", "url"] as const;

export type CommandSection = (typeof COMMAND_SECTIONS)[number];
export type CommandField = (typeof COMMAND_FIELDS)[number];

export type AppCommand =
  | { action: "navigate"; path: CommandSection }
  /** Display name fragment to match against vault items. Never a secret. */
  | { action: "open_item"; query: string }
  | { action: "copy_field"; query: string; field: CommandField }
  | { action: "search"; query: string }
  | { action: "help" };

export type CommandOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };
