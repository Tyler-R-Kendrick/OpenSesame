/** Fixed first-page Issuing inventory; sensitive card fields never enter its result. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
function printable(value: string) {
  return /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
}
const code = z.string().min(1).max(64).refine(printable);
const cards = z.object({
  object: z.literal("list"),
  url: z.literal("/v1/issuing/cards"),
  has_more: z.boolean(),
  data: z
    .array(
      z.object({
        object: z.literal("issuing.card"),
        id: z
          .string()
          .regex(/^ic_[A-Za-z0-9]{1,128}$/)
          .refine(printable),
        status: code,
        type: code,
        currency: z
          .string()
          .length(3)
          .regex(/^[a-z]{3}$/),
      }),
    )
    .max(20),
  error: z.never().optional(),
  errors: z.never().optional(),
});

export function parseNativeStripeIssuingCards(body: BoundaryValue) {
  const parsed = cards.safeParse(body);
  if (!parsed.success) throw new NativeApiError("response");
  if (
    new Set(parsed.data.data.map((card) => card.id)).size !==
    parsed.data.data.length
  )
    throw new NativeApiError("response");
  return parsed.data;
}

export function projectNativeStripeIssuingCards(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativeStripeIssuingCards(body);
  return {
    label: `Showing ${value.data.length} Issuing cards${value.has_more ? " from first page; more available" : ""}`,
    items: value.data.map((card) => ({
      id: card.id,
      label: `${card.id} — ${card.status} (${card.type})`,
    })),
  };
}
