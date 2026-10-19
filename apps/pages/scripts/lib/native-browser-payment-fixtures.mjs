/** Finite documented payment inventory replies; only synthetic test values. */
import {
  LITHIC_PROBE_REPLY,
  LITHIC_READ,
} from "./native-browser-lithic-fixture.mjs";
import {
  PRIVACY_PROBE_REPLY,
  PRIVACY_READ,
} from "./native-browser-privacy-fixture.mjs";
const PAYMENT_PROBE_REPLIES = {
  agentcard: {
    object: "api_v2",
    organization_id: "owned-organization",
    test_mode: true,
  },
  marqeta: {
    count: 1,
    start_index: 0,
    end_index: 0,
    is_more: false,
    data: [{ token: "owned-user", active: true }],
  },
  lithic: LITHIC_PROBE_REPLY,
  privacy: PRIVACY_PROBE_REPLY,
  razorpay: {
    entity: "collection",
    count: 1,
    items: [
      {
        entity: "payment",
        id: "pay_contract",
        status: "captured",
        currency: "INR",
        amount: 1500,
      },
    ],
  },
  "stripe-issuing": {
    object: "list",
    url: "/v1/issuing/cards",
    has_more: false,
    data: [
      {
        object: "issuing.card",
        id: "ic_contract",
        status: "active",
        type: "virtual",
        currency: "usd",
      },
    ],
  },
  stripe: {
    object: "balance",
    livemode: false,
    available: [{ amount: 1500, currency: "usd" }],
    pending: [{ amount: -7, currency: "jpy" }],
  },
};
const PAYMENT_READS = {
  agentcard: {
    id: "provider.organization.read",
    label: "Read platform organization",
    method: "GET",
    url: "https://api.agentcard.sh/api/v2",
    headers: {},
    absentHeaders: ["x-user-token", "x-api-version"],
    reply: PAYMENT_PROBE_REPLIES.agentcard,
    result: {
      label: "Agentcard platform organization (test mode)",
      items: [
        { id: "owned-organization", label: "owned-organization — test mode" },
      ],
    },
    excludedText: [],
  },
  marqeta: {
    id: "provider.users.read",
    label: "List users",
    method: "GET",
    url: "https://sandbox-api.marqeta.com/v3/users?count=10&start_index=0&fields=token%2Cactive",
    headers: {},
    absentHeaders: ["api-version", "x-marqeta-account"],
    reply: PAYMENT_PROBE_REPLIES.marqeta,
    result: {
      label: "Showing 1 users from first page",
      items: [{ id: "owned-user", label: "owned-user — active" }],
    },
    excludedText: [],
  },
  lithic: LITHIC_READ,
  privacy: PRIVACY_READ,
  razorpay: {
    id: "provider.payments.read",
    label: "List payments",
    method: "GET",
    url: "https://api.razorpay.com/v1/payments?count=20&skip=0",
    headers: {},
    absentHeaders: ["x-razorpay-account"],
    reply: PAYMENT_PROBE_REPLIES.razorpay,
    result: {
      label: "Showing 1 payments from first page; amounts in minor units",
      items: [
        {
          id: "pay_contract",
          label: "pay_contract — captured (INR 1500 minor units)",
        },
      ],
    },
    excludedText: [],
  },
  "stripe-issuing": {
    id: "provider.issuing-cards.read",
    label: "List Issuing cards",
    method: "GET",
    url: "https://api.stripe.com/v1/issuing/cards?limit=20",
    headers: { "Stripe-Version": "2026-09-30.endive" },
    absentHeaders: ["stripe-account"],
    reply: PAYMENT_PROBE_REPLIES["stripe-issuing"],
    result: {
      label: "Showing 1 Issuing cards",
      items: [{ id: "ic_contract", label: "ic_contract — active (virtual)" }],
    },
    excludedText: [],
  },
  stripe: {
    id: "provider.balance.read",
    label: "Read account balance",
    method: "GET",
    url: "https://api.stripe.com/v1/balance",
    headers: { "Stripe-Version": "2026-09-30.endive" },
    absentHeaders: ["stripe-account"],
    reply: PAYMENT_PROBE_REPLIES.stripe,
    result: {
      label: "Stripe balance (sandbox); amounts in minor units",
      items: [
        { id: "available:usd", label: "Available USD: 1500 minor units" },
        { id: "pending:jpy", label: "Pending JPY: -7 minor units" },
      ],
    },
    excludedText: [],
  },
};
export function paymentProbeReply(providerId) {
  return Object.hasOwn(PAYMENT_PROBE_REPLIES, providerId)
    ? structuredClone(PAYMENT_PROBE_REPLIES[providerId])
    : null;
}
export function paymentReadFixture(providerId, url, parameters) {
  if (!Object.hasOwn(PAYMENT_READS, providerId)) return null;
  const read = structuredClone(PAYMENT_READS[providerId]);
  if (["lithic", "privacy", "marqeta"].includes(providerId))
    read.url = url.replace("{program_host}", parameters.program_host ?? "");
  return read;
}
