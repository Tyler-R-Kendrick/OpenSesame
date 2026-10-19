/** Fixed first-page payment inventory; private payment fields never enter its result. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const payments = z.object({
  entity: z.literal("collection"),
  count: z.number().int().min(0).max(20),
  items: z
    .array(
      z.object({
        entity: z.literal("payment"),
        id: z.string().regex(/^pay_[A-Za-z0-9]{1,128}$/),
        status: z.enum([
          "created",
          "authorized",
          "captured",
          "refunded",
          "failed",
        ]),
        currency: z.string().regex(/^[A-Z]{3}$/),
        amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(20),
  error: z.never().optional(),
  errors: z.never().optional(),
});

export function parseNativeRazorpayPayments(body: BoundaryValue) {
  const parsed = payments.safeParse(body);
  if (!parsed.success) throw new NativeApiError("response");
  const value = parsed.data;
  if (
    value.count !== value.items.length ||
    new Set(value.items.map((item) => item.id)).size !== value.count
  )
    throw new NativeApiError("response");
  return value;
}

export function projectNativeRazorpayPayments(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativeRazorpayPayments(body);
  return {
    label: `Showing ${value.count} payments from first page; amounts in minor units`,
    items: value.items.map((payment) => ({
      id: payment.id,
      label: `${payment.id} — ${payment.status} (${payment.currency} ${payment.amount} minor units)`,
    })),
  };
}
