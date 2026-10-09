/** Synthetic upstream identities for browser protocol tests, never live accounts. */
import { CONNECT_PLAN_JSON } from "../../../../packages/app-core/src/lib/connect-presets.generated.ts";
import {
  isJsonObject,
  isString,
} from "../../../../scripts/lib/json-boundary.mjs";

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
  return {
    providerId: plan.id,
    name: plan.name,
    preset,
    variant,
    parameters,
    credentials,
    reply,
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
