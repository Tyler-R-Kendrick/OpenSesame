/** Synthetic upstream identities for browser protocol tests, never live accounts. */
import {
  isJsonObject,
  isString,
} from "../../../../scripts/lib/json-boundary.mjs";
import { NATIVE_CONNECT_PLAN_JSON as CONNECT_PLAN_JSON } from "./native-browser-catalog-projection.mjs";

import {
  LITHIC_PROBE_REPLY,
  LITHIC_READ,
} from "./native-browser-lithic-fixture.mjs";

const PARAMETER_VALUES = {
  application_id: "contractapp",
  company_domain: "contractcompany",
  organization: "contractorganization",
  account: "contractaccount",
  instance: "contractinstance",
  project_id: "contractproject",
  workspace_id: "contractworkspace",
};

const DOCUMENTED_PROBE_REPLIES = {
  lithic: LITHIC_PROBE_REPLY,
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
  // https://docs.agentmail.to/api-reference/inboxes/list
  agentmail: {
    count: 1,
    inboxes: [
      {
        inbox_id: "owned-inbox",
        email: "owned@example.test",
        display_name: "Protocol authority AgentMail inbox",
      },
    ],
  },
  stripe: {
    object: "balance",
    livemode: false,
    available: [{ amount: 1500, currency: "usd" }],
    pending: [{ amount: -7, currency: "jpy" }],
  },
  algolia: {
    items: [
      {
        name: "products",
        entries: 1,
        dataSize: 128,
        lastBuildTimeS: 1,
        pendingTask: false,
        primary: true,
      },
    ],
    nbPages: 1,
  },
  anthropic: {
    data: [
      {
        id: "claude-contract",
        type: "model",
        display_name: "Protocol authority model",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    has_more: false,
    first_id: "claude-contract",
    last_id: "claude-contract",
  },
  notion: {
    object: "user",
    id: "11111111-1111-4111-8111-111111111111",
    type: "bot",
    name: "Protocol authority Notion bot",
    bot: {
      owner: { type: "workspace", workspace: true },
      workspace_name: "Protocol authority workspace",
    },
  },
  resend: {
    data: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "contract.example.test",
        status: "verified",
        region: "us-east-1",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    has_more: false,
  },
  postmark: {
    ID: 42,
    Name: "Protocol authority Postmark server",
    ServerLink: "https://account.postmarkapp.com/servers/42",
    DeliveryType: "Live",
    ApiTokens: [],
  },
  gemini: {
    models: [
      {
        name: "models/gemini-contract",
        version: "001",
        displayName: "Protocol authority Gemini model",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  },
};

const DOCUMENTED_READS = {
  lithic: LITHIC_READ,
  datadog: {
    id: "provider.monitors.read",
    label: "List monitors",
    method: "GET",
    url: "https://api.datadoghq.com/api/v1/monitor?page=0&page_size=20",
    headers: { "DD-APPLICATION-KEY": "{application_key}" },
    absentHeaders: ["authorization"],
    reply: [{ id: 12861, name: "Protocol monitor", query: "private query" }],
    result: {
      label: "Showing 1 monitor from first page",
      items: [{ id: "12861", label: "Protocol monitor" }],
    },
    excludedText: ["private query"],
  },
  razorpay: {
    id: "provider.payments.read",
    label: "List payments",
    method: "GET",
    url: "https://api.razorpay.com/v1/payments?count=20&skip=0",
    headers: {},
    absentHeaders: ["x-razorpay-account"],
    reply: DOCUMENTED_PROBE_REPLIES.razorpay,
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
    reply: DOCUMENTED_PROBE_REPLIES["stripe-issuing"],
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
    reply: DOCUMENTED_PROBE_REPLIES.stripe,
    result: {
      label: "Stripe balance (sandbox); amounts in minor units",
      items: [
        { id: "available:usd", label: "Available USD: 1500 minor units" },
        { id: "pending:jpy", label: "Pending JPY: -7 minor units" },
      ],
    },
    excludedText: [],
  },
  algolia: {
    id: "provider.indices.read",
    label: "List indices",
    method: "GET",
    url: "https://contractapp-dsn.algolia.net/1/indexes?page=0&hitsPerPage=20",
    headers: { "X-Algolia-Application-Id": "{application_id}" },
    absentHeaders: ["authorization"],
    reply: {
      items: [
        {
          name: "products",
          entries: 194,
          privateMetadata: "private index metadata",
        },
        { name: "suppliers", entries: 83 },
      ],
      nbPages: 7,
    },
    result: {
      label: "Showing 2 indices from first page",
      items: [
        { id: "products", label: "products" },
        { id: "suppliers", label: "suppliers" },
      ],
    },
    excludedText: ["private index metadata"],
  },
  postmark: {
    id: "provider.messages.read",
    label: "List outbound messages",
    method: "GET",
    url: "https://api.postmarkapp.com/messages/outbound?count=20&offset=0&messagestream=outbound",
    headers: { Accept: "application/json" },
    absentHeaders: ["authorization", "x-postmark-account-token"],
    reply: {
      TotalCount: 194,
      Messages: [
        {
          MessageID: "0ac29aee-e1cd-480d-b08d-4f48548ff48d",
          MessageStream: "outbound",
          Subject: "Protocol welcome",
          Status: "Sent",
          To: [{ Email: "private-recipient@example.test", Name: null }],
          Recipients: ["private-recipient@example.test"],
          From: "private-sender@example.test",
          Metadata: { private: "private metadata must not render" },
        },
        {
          MessageID: "e30970cd-3901-4cc4-8b52-9e7dd57ce350",
          MessageStream: "outbound",
          Subject: "Protocol followup",
          Status: "Queued",
        },
      ],
    },
    result: {
      label: "Showing 2 of 194 messages in outbound stream",
      items: [
        {
          id: "0ac29aee-e1cd-480d-b08d-4f48548ff48d",
          label: "Protocol welcome — Sent",
        },
        {
          id: "e30970cd-3901-4cc4-8b52-9e7dd57ce350",
          label: "Protocol followup — Queued",
        },
      ],
    },
    excludedText: [
      "private-recipient@example.test",
      "private-sender@example.test",
      "private metadata must not render",
    ],
  },
};

export function nativeBrowserPlans() {
  return CONNECT_PLAN_JSON.map((json) => {
    const plan = JSON.parse(json);
    if (
      !isJsonObject(plan) ||
      !isString(plan.id) ||
      !Array.isArray(plan.methods)
    )
      throw new Error("Compiled browser provider plan is malformed.");
    return plan;
  });
}

function setField(root, path, value) {
  const parts = path.split(".");
  let parent = root;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) parent[part] = value;
    else {
      parent[part] ??= /^\d+$/.test(parts[index + 1]) ? [] : {};
      parent = parent[part];
    }
  }
}

function verificationReply(id, verification) {
  const documented = DOCUMENTED_PROBE_REPLIES[id];
  // Strict payment reads need their documented typed collections, not string placeholders.
  if (
    id === "stripe" ||
    id === "stripe-issuing" ||
    id === "razorpay" ||
    id === "lithic"
  )
    return structuredClone(documented);
  if (
    !documented &&
    !verification.accountField &&
    verification.requiredFields.length === 0 &&
    verification.success.length === 0
  )
    return null;
  const reply = documented ? structuredClone(documented) : {};
  for (const field of verification.requiredFields)
    setField(reply, field, `contract-${id}-${field.split(".").at(-1)}`);
  if (verification.accountField && !documented)
    setField(
      reply,
      verification.accountField,
      `Protocol authority ${id} account`,
    );
  for (const predicate of verification.success)
    setField(reply, predicate.field, predicate.equals);
  return reply;
}

function fixtureCredentials(plan, preset, variant) {
  const parameters = {};
  const credentials = { api_key: `browser-protocol-only-${plan.id}` };
  for (const field of preset.templateParams) {
    const value =
      field.choices?.[0]?.value ??
      PARAMETER_VALUES[field.name] ??
      `contract-${field.name}`;
    (field.secret ? credentials : parameters)[field.name] = value;
  }
  for (const field of preset.additionalCredentials)
    credentials[field.name] = `browser-protocol-only-${field.name}`;
  if (variant) parameters.credential_variant = variant.id;
  return { parameters, credentials };
}

export function nativeApiFixture(plan, variantId) {
  const method = plan.methods.find(
    (item) => item.kind === "api-key" && item.preset,
  );
  if (!method?.preset?.auth || !method.preset.verify) return null;
  const base = method.preset;
  const variant =
    base.credentialVariants.find((item) => item.id === variantId) ??
    base.credentialVariants[0];
  const preset = variant ? { ...base, ...variant } : base;
  const { parameters, credentials } = fixtureCredentials(plan, preset, variant);
  const reply = verificationReply(plan.id, preset.verify);
  if (!reply) return null;
  const read = DOCUMENTED_READS[plan.id]
    ? structuredClone(DOCUMENTED_READS[plan.id])
    : null;
  if (read && plan.id === "lithic") read.url = preset.verify.url;
  return {
    providerId: plan.id,
    name: plan.name,
    preset,
    variant,
    parameters,
    credentials,
    reply,
    read,
  };
}

export const NATIVE_REPRESENTATIVE_API_IDS = [
  "algolia",
  "datadog",
  "anthropic",
  "notion",
  "railway",
  "resend",
  "postmark",
  "gemini",
];
