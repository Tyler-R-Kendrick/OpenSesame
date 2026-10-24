/** Only closed provider-specific read contracts can admit a payment connector. */
import { agentcardReadContract } from "./readonly-agentcard.mjs";
import { lithicReadContract } from "./readonly-lithic.mjs";
import { marqetaReadContract } from "./readonly-marqeta.mjs";
import { privacyReadContract } from "./readonly-privacy.mjs";
import { razorpayReadContract } from "./readonly-razorpay.mjs";

export const READONLY_PAYMENT_IDS = new Set([
  "agentcard",
  "stripe",
  "stripe-issuing",
  "razorpay",
  "lithic",
  "privacy",
  "marqeta",
]);

function stripeReadContract(id, apiKey) {
  const url =
    id === "stripe"
      ? "https://api.stripe.com/v1/balance"
      : id === "stripe-issuing"
        ? "https://api.stripe.com/v1/issuing/cards?limit=20"
        : null;
  return (
    url !== null &&
    apiKey?.verify?.method === "GET" &&
    apiKey.verify.url === url &&
    (id !== "stripe-issuing" ||
      apiKey.verify.headers?.["Stripe-Version"] === "2026-09-30.endive") &&
    apiKey.auth?.kind === "header" &&
    apiKey.auth.header === "Authorization" &&
    apiKey.auth.scheme === "Bearer"
  );
}

export function readonlyPaymentContract(id, apiKey) {
  return (
    (id === "agentcard" && agentcardReadContract(apiKey)) ||
    stripeReadContract(id, apiKey) ||
    (id === "razorpay" && razorpayReadContract(apiKey)) ||
    (id === "lithic" && lithicReadContract(apiKey)) ||
    (id === "privacy" && privacyReadContract(apiKey)) ||
    (id === "marqeta" && marqetaReadContract(apiKey))
  );
}
