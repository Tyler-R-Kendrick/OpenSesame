/** Fixed non-PCI inventory: no PAN, CVC, expiry, memo or account identifiers survive. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const cards = z.object({
  data: z
    .array(
      z.object({
        token: z
          .string()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        state: z.enum([
          "CLOSED",
          "OPEN",
          "PAUSED",
          "PENDING_ACTIVATION",
          "PENDING_FULFILLMENT",
        ]),
        type: z.enum([
          "MERCHANT_LOCKED",
          "PHYSICAL",
          "SINGLE_USE",
          "VIRTUAL",
          "UNLOCKED",
          "DIGITAL_WALLET",
        ]),
      }),
    )
    .max(20),
  has_more: z.boolean(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
export function parseNativeLithicCards(body: BoundaryValue) {
  const result = cards.safeParse(body);
  if (
    !result.success ||
    new Set(result.data.data.map((card) => card.token.toLowerCase())).size !==
      result.data.data.length
  )
    throw new NativeApiError("response");
  return result.data;
}
export function projectNativeLithicCards(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativeLithicCards(body);
  return {
    label: `Showing ${value.data.length} cards from first page${value.has_more ? "; more available" : ""}`,
    items: value.data.map((card) => ({
      id: card.token,
      label: `${card.token} — ${card.state} (${card.type})`,
    })),
  };
}
