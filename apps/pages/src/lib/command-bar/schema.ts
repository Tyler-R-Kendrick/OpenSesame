import { z } from "zod";
import { COMMAND_FIELDS, COMMAND_SECTIONS } from "./types.js";

/**
 * The model's answer, validated. Loaded only with the AI SDK, on the path
 * that actually asks a model (`interpret.ts`); `types.ts` is what the shell
 * imports at boot.
 */
export const appCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("navigate"),
    path: z.enum(COMMAND_SECTIONS),
  }),
  z.object({
    action: z.literal("open_item"),
    /** Display name fragment to match against vault items. Never a secret. */
    query: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("copy_field"),
    query: z.string().min(1).max(120),
    field: z.enum(COMMAND_FIELDS),
  }),
  z.object({
    action: z.literal("search"),
    query: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("help"),
  }),
  z.object({
    action: z.literal("open_path"),
    path: z.string().min(1).max(200),
    label: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("refuse"),
    message: z.string().min(1).max(200),
  }),
]);
