/** Dedicated private native DATA codec. Every reply is parsed before exposing its typed payload. */
import { z } from "zod";
const reply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ack") }),
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({ kind: z.literal("available"), acquired: z.boolean() }),
  z.strictObject({ kind: z.literal("bytes"), base64: z.string().nullable() }),
  z.strictObject({
    kind: z.literal("names"),
    values: z.array(z.string()).max(4096),
  }),
  z.strictObject({
    kind: z.literal("inventory"),
    entries: z.array(z.tuple([z.string(), z.boolean()])).max(4096),
  }),
  z.strictObject({
    kind: z.literal("identity"),
    value: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("projection"),
    records: z.array(z.tuple([z.string(), z.string()])).max(512),
  }),
]);
export const nativeDataResponse = z.strictObject({ v: z.literal(1), reply });
export type NativeDataReply = z.infer<typeof reply>;
export type NativeDataCommand =
  | {
      kind:
        | "close"
        | "validate"
        | "credential_try"
        | "body_close"
        | "capture_inventory"
        | "inventory_close"
        | "inventory_tombs"
        | "read_generation"
        | "read_projection"
        | "state_identity"
        | "validate_state";
    }
  | {
      kind:
        | "body_try"
        | "body_or_bootstrap_try"
        | "capture_body_reader"
        | "read_retired";
      tomb: string;
    }
  | { kind: "identity"; scope: "vault" | "origin" }
  | { kind: "lease_try"; logical: string; mode: "exclusive" | "shared" }
  | { kind: "read_device"; logical_key: string }
  | {
      kind: "publish_device";
      logical_key: string;
      expected: string | null;
      next: string;
    }
  | { kind: "publish_header"; expected: string; next: string }
  | {
      kind: "publish_projection";
      expected: [string, string][];
      writes: [string, string][];
    };
