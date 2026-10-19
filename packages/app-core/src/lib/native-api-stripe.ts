/** Stripe's read-only balance contract; amounts remain exact integer minor units. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const amount = z.object({
  amount: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-z]{3}$/),
});
const balance = z.object({
  object: z.literal("balance"),
  livemode: z.boolean(),
  available: z.array(amount).max(50),
  pending: z.array(amount).max(50),
  error: z.never().optional(),
  errors: z.never().optional(),
});

export function parseNativeStripeBalance(body: BoundaryValue) {
  const parsed = balance.safeParse(body);
  if (!parsed.success) throw new NativeApiError("response");
  for (const rows of [parsed.data.available, parsed.data.pending])
    if (new Set(rows.map((row) => row.currency)).size !== rows.length)
      throw new NativeApiError("response");
  return parsed.data;
}

export function projectNativeStripeBalance(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativeStripeBalance(body);
  return {
    label: `Stripe balance (${value.livemode ? "live" : "sandbox"}); amounts in minor units`,
    items: (["available", "pending"] as const).flatMap((kind) =>
      value[kind].map((row) => ({
        id: `${kind}:${row.currency}`,
        label: `${kind === "available" ? "Available" : "Pending"} ${row.currency.toUpperCase()}: ${row.amount} minor units`,
      })),
    ),
  };
}
