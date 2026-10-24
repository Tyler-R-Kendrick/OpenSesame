/** Fixed first-page inventory; card details and funding fields never enter its result. */
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
        state: z.enum(["CLOSED", "OPEN", "PAUSED"]),
        type: z.enum([
          "DIGITAL_WALLET",
          "MERCHANT_LOCKED",
          "SINGLE_USE",
          "UNLOCKED",
        ]),
      }),
    )
    .max(20),
  page: z.literal(1),
  total_entries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_pages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  error: z.never().optional(),
  errors: z.never().optional(),
});
export function parseNativePrivacyCards(body: BoundaryValue) {
  const result = cards.safeParse(body);
  if (!result.success) throw new NativeApiError("response");
  const value = result.data;
  if (
    new Set(value.data.map((card) => card.token.toLowerCase())).size !==
      value.data.length ||
    value.data.length > value.total_entries ||
    (value.total_entries > 0 &&
      (value.data.length === 0 || value.total_pages === 0)) ||
    (value.total_entries === 0 && value.total_pages > 1) ||
    (value.total_entries > 0 && value.total_pages > value.total_entries)
  )
    throw new NativeApiError("response");
  return value;
}
export function projectNativePrivacyCards(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativePrivacyCards(body);
  return {
    label: `Showing ${value.data.length} cards from first page${value.total_pages > 1 ? "; more available" : ""}`,
    items: value.data.map((card) => ({
      id: card.token,
      label: `${card.token} — ${card.state} (${card.type})`,
    })),
  };
}
