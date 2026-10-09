/** Conservative browser admission, independently of hosted connector contracts. */
import { z } from "zod";
import { type ConnectPlan, connectPlan } from "./connect-plan.js";
import { NATIVE_BROWSER_POLICY_JSON } from "./native-browser-policy.generated.js";

const ruleSchema = z.object({
  provider_id: z.string(),
  method: z.enum(["api-key", "oauth", "mcp", "oidc"]),
  origins: z.array(z.string().url()).min(1).optional(),
  parameters: z.record(z.string(), z.string()),
  reason: z.string().min(1),
  evidence_urls: z.array(z.string().url()).min(1),
});
const policy = z
  .object({
    schema_version: z.literal(1),
    audited_origin: z.string().url(),
    checked_date: z.string(),
    qualification: z.string(),
    rules: z.array(ruleSchema),
  })
  .parse(JSON.parse(NATIVE_BROWSER_POLICY_JSON));

const originBindings: { origin: () => string }[] = [];

function policyOrigin(): string {
  return originBindings.at(-1)?.origin() ?? policy.audited_origin;
}

/** Origin-scoped evidence cannot deny an operator's separately configured origin. */
export function bindNativeBrowserPolicyOrigin(
  origin: () => string,
): () => void {
  const binding = { origin };
  originBindings.push(binding);
  return () => {
    const index = originBindings.indexOf(binding);
    if (index >= 0) originBindings.splice(index, 1);
  };
}

export type NativeBrowserPolicyDecision = {
  available: boolean;
  reason: string | null;
  evidenceUrls: readonly string[];
};
function publicDefaults(
  providerId: string,
  supplied: Readonly<Record<string, string>>,
) {
  const method = connectPlan(providerId)?.methods.find(
    (entry) => entry.kind === "api-key",
  );
  if (method?.kind !== "api-key" || !method.preset) return supplied;
  const preset = method.preset;
  const variantId =
    supplied.credential_variant ?? preset.credentialVariants[0]?.id;
  const profile =
    preset.credentialVariants.find((entry) => entry.id === variantId) ?? preset;
  const parameters = { ...supplied };
  if (variantId) parameters.credential_variant = variantId;
  for (const field of profile.templateParams) {
    if (!field.secret && field.choices?.length)
      parameters[field.name] =
        supplied[field.name]?.trim() || field.choices[0].value;
  }
  return parameters;
}
export function nativeBrowserMethodPolicy(
  providerId: string,
  method: ConnectPlan["methods"][number]["kind"] | "native-local" | "oidc",
  parameters: Readonly<Record<string, string>> = {},
): NativeBrowserPolicyDecision {
  const selected =
    method === "api-key" ? publicDefaults(providerId, parameters) : parameters;
  const rule = policy.rules.find(
    (entry) =>
      entry.provider_id === providerId &&
      entry.method === method &&
      (!entry.origins || entry.origins.includes(policyOrigin())) &&
      Object.entries(entry.parameters).every(
        ([name, value]) => selected[name] === value,
      ),
  );
  return rule
    ? {
        available: false,
        reason: rule.reason,
        evidenceUrls: [...rule.evidence_urls],
      }
    : { available: true, reason: null, evidenceUrls: [] };
}
export function nativeBrowserApiPolicy(
  providerId: string,
  parameters: Readonly<Record<string, string>> = {},
): NativeBrowserPolicyDecision {
  return nativeBrowserMethodPolicy(providerId, "api-key", parameters);
}
export function nativeBrowserOAuthPolicy(
  providerId: string,
): NativeBrowserPolicyDecision {
  return nativeBrowserMethodPolicy(providerId, "oauth");
}
export function nativeBrowserMcpPolicy(
  providerId: string,
): NativeBrowserPolicyDecision {
  return nativeBrowserMethodPolicy(providerId, "mcp");
}
export function assertNativeBrowserMcpPolicy(providerId: string): void {
  const decision = nativeBrowserMcpPolicy(providerId);
  if (!decision.available)
    throw new Error(decision.reason ?? "Browser MCP is unavailable");
}
export function assertNativeBrowserOAuthPolicy(providerId: string): void {
  const decision = nativeBrowserOAuthPolicy(providerId);
  if (!decision.available)
    throw new Error(decision.reason ?? "Browser OAuth is unavailable");
}
