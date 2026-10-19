/** Provider-specific inventory validation runs before any verification proof is saved. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { parseNativeLithicCards } from "./native-api-lithic.js";
import { parseNativeRazorpayPayments } from "./native-api-razorpay.js";
import { parseNativeStripeIssuingCards } from "./native-api-stripe-issuing.js";
import { parseNativeStripeBalance } from "./native-api-stripe.js";

export function validateNativeApiInventory(
  providerId: string,
  body: BoundaryValue,
): void {
  if (providerId === "lithic") parseNativeLithicCards(body);
  if (providerId === "razorpay") parseNativeRazorpayPayments(body);
  if (providerId === "stripe") parseNativeStripeBalance(body);
  if (providerId === "stripe-issuing") parseNativeStripeIssuingCards(body);
}
