/**
 * The driver relay protocol: JSON messages carrying exactly the
 * `BrowserDriver` surface, so a browser that lives somewhere else (a Boat
 * sandbox, a future WASM host with a real engine) can be driven from here
 * without provider credentials or site secrets ever entering a command
 * log. `fillSecret` values cross only inside this authenticated channel,
 * one fill at a time, exactly as the local stdin fill does.
 */

import type { Observation } from "@opensesame/cua-password-reset";
import { z } from "zod";

export const RELAY_METHODS = [
  "open",
  "snapshot",
  "click",
  "fill",
  "fillSecret",
  "pageUrl",
  "close",
] as const;
export type RelayMethod = (typeof RELAY_METHODS)[number];

export interface RelayRequest {
  id: number;
  method: RelayMethod;
  url?: string | undefined;
  ref?: string | undefined;
  value?: string | undefined;
}

/**
 * First frame on a relay socket. Browser/WASM WebSocket clients cannot set
 * upgrade headers, so the bearer token travels as this frame instead; the
 * relay answers `{id: 0, ok: true}` and refuses requests before it.
 */
export interface RelayAuth {
  type: "auth";
  token: string;
}

export type RelayResponse =
  | {
      id: number;
      ok: true;
      observation?: Observation | undefined;
      pageUrl?: string | undefined;
    }
  | { id: number; ok: false; error: string };

/** One request/response round trip. Transport is the caller's choice. */
export type RelayTransport = (request: RelayRequest) => Promise<RelayResponse>;

const relayRequestSchema = z.object({
  id: z.number(),
  method: z.enum(RELAY_METHODS),
  url: z.string().optional(),
  ref: z.string().optional(),
  value: z.string().optional(),
});

const relayAuthSchema = z.object({
  type: z.literal("auth"),
  token: z.string(),
});

const relayResponseSchema = z.union([
  z.object({
    id: z.number(),
    ok: z.literal(true),
    observation: z
      .object({
        id: z.string(),
        origin: z.string(),
        fields: z.array(
          z.object({
            ref: z.string(),
            kind: z.enum([
              "email",
              "text",
              "password",
              "otp",
              "button",
              "link",
              "static",
            ]),
            label: z.string(),
          }),
        ),
      })
      .optional(),
    pageUrl: z.string().optional(),
  }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
]);

/** Parse one relay response frame; anything else is not a relay message. */
export function parseRelayResponse(text: string): RelayResponse | null {
  const parsed = relayResponseSchema.safeParse(parseJsonText(text));
  return parsed.success ? parsed.data : null;
}

function parseJsonText(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Parse one inbound relay frame; anything else is not a relay message. */
export function parseRelayFrame(
  text: string,
): { auth: RelayAuth } | { request: RelayRequest } | null {
  const parsed = parseJsonText(text);
  const auth = relayAuthSchema.safeParse(parsed);
  if (auth.success) return { auth: auth.data };
  const request = relayRequestSchema.safeParse(parsed);
  if (request.success) return { request: request.data };
  return null;
}
