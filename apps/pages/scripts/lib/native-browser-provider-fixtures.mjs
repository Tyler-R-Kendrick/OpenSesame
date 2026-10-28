/** Synthetic upstream identities for browser protocol tests, never live accounts. */
import {
  isJsonObject,
  isString,
} from "../../../../scripts/lib/json-boundary.mjs";
import {
  NATIVE_CONNECT_PLAN_JSON as CONNECT_PLAN_JSON,
  NATIVE_API_FAMILIES,
  NATIVE_CANONICAL_CATALOG_IDS,
  NATIVE_SHARED_AI_PRESETS,
} from "./native-browser-catalog-projection.mjs";
import {
  DOCUMENTED_PROBE_REPLIES,
  DOCUMENTED_READS,
} from "./native-browser-documented-provider-fixtures.mjs";
import {
  paymentProbeReply,
  paymentReadFixture,
} from "./native-browser-payment-fixtures.mjs";

const PARAMETER_VALUES = {
  host: "obsidian.example.test",
  program_host: "program-api.example.test",
  application_id: "contractapp",
  company_domain: "contractcompany",
  organization: "contractorganization",
  account: "contractaccount",
  instance: "contractinstance",
  project_id: "contractproject",
  workspace_id: "contractworkspace",
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
      const next = parts[index + 1];
      // A documented reply may carry a scalar at a parent path while a
      // nested predicate names a child of it; replace the scalar with the
      // object/array the deeper field needs.
      if (
        parent[part] === null ||
        (!isJsonObject(parent[part]) && !Array.isArray(parent[part]))
      )
        parent[part] = /^\d+$/.test(next) ? [] : {};
      parent = parent[part];
    }
  }
}

function canUseReadAsVerification(verification) {
  return (
    !verification.accountField &&
    verification.requiredFields.length === 0 &&
    verification.success.length === 0
  );
}

function verificationReply(id, verification) {
  const payment = paymentProbeReply(id);
  if (payment) return payment;
  const readCanVerify = canUseReadAsVerification(verification);
  const documented =
    DOCUMENTED_PROBE_REPLIES[id] ??
    (readCanVerify ? DOCUMENTED_READS[id]?.reply : undefined);
  if (id === "linq") return structuredClone(documented);
  if (!documented && readCanVerify)
    // Shared-AI form fixtures issue no native verification request.
    return NATIVE_SHARED_AI_PRESETS.has(id) ? {} : null;
  const reply = documented ? structuredClone(documented) : {};
  for (const field of verification.requiredFields) {
    const current = field
      .split(".")
      .reduce((value, part) => value?.[part], reply);
    if (current === undefined)
      setField(reply, field, `contract-${id}-${field.split(".").at(-1)}`);
  }
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
      PARAMETER_VALUES[field.name] ??
      field.defaultValue ??
      field.choices?.[0]?.value ??
      (field.required ? `contract-${field.name}` : "");
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
  const read =
    paymentReadFixture(plan.id, preset.verify.url, parameters) ??
    (DOCUMENTED_READS[plan.id]
      ? structuredClone(DOCUMENTED_READS[plan.id])
      : null);
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
  "linq",
];

export const NATIVE_VISIBLE_API_IDS = nativeBrowserPlans()
  .filter((plan) => plan.id !== "linear")
  .filter((plan) => NATIVE_CANONICAL_CATALOG_IDS.includes(plan.id))
  .filter((plan) => nativeApiFixture(plan))
  .map((plan) => plan.id);

export const NATIVE_FAMILY_API_IDS = nativeBrowserPlans()
  .filter((plan) =>
    NATIVE_API_FAMILIES.some((family) => family.members.includes(plan.id)),
  )
  .filter((plan) => nativeApiFixture(plan))
  .map((plan) => plan.id);

export const NATIVE_COMPLETE_API_IDS = [
  ...new Set([...NATIVE_VISIBLE_API_IDS, ...NATIVE_FAMILY_API_IDS]),
];
