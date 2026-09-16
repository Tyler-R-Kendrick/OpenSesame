import { z } from "zod";

/** Closed set of actions the command bar may run. The model picks among these. */
export const appCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("navigate"),
    path: z.enum([
      "/vault",
      "/connections",
      "/access",
      "/identity",
      "/settings",
    ]),
  }),
  z.object({
    action: z.literal("open_item"),
    /** Display name fragment to match against vault items. Never a secret. */
    query: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("copy_field"),
    query: z.string().min(1).max(120),
    field: z.enum(["password", "username", "otp", "url"]),
  }),
  z.object({
    action: z.literal("search"),
    query: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("help"),
  }),
]);

export type AppCommand = z.infer<typeof appCommandSchema>;

export type CommandOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };
