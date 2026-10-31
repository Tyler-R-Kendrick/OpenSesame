/** Resolve only compiled provider targets and classified tenant inputs. */
import type { ApiKeyPreset } from "./connect-plan.js";
import { connectPlan } from "./connect-plan.js";
import type { NativeFieldClassification } from "./native-connector-schema.js";

export interface NativeApiCredentials {
  [name: string]: string;
}

export type NativeApiProfile = Pick<
  ApiKeyPreset,
  "auth" | "verify" | "templateParams" | "additionalCredentials"
>;
export type NativeApiTarget = {
  providerId: string;
  providerName: string;
  profile: NativeApiProfile;
  parameters: Record<string, string>;
  classification: NativeFieldClassification;
};
/**
 * The verify contract as it is hashed: without an empty `validStatuses`, so a
 * contract that names no proof status keeps the fingerprint saved connections
 * were configured under before the field existed.
 */
function fingerprintedVerify(verify: NativeApiProfile["verify"]) {
  if (!verify || verify.validStatuses.length > 0) return verify;
  const { validStatuses: _empty, ...rest } = verify;
  return rest;
}

export async function nativeApiFingerprint(
  target: NativeApiTarget,
): Promise<string> {
  const verifyForFingerprint = fingerprintedVerify(target.profile.verify);
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      providerId: target.providerId,
      method: "api-key",
      parameters: Object.fromEntries(Object.entries(target.parameters).sort()),
      auth: target.profile.auth,
      verify: verifyForFingerprint,
      classification: target.classification,
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function nativeApiTarget(
  providerId: string,
  supplied: Record<string, string>,
): NativeApiTarget {
  const plan = connectPlan(providerId);
  const method = plan?.methods.find((entry) => entry.kind === "api-key");
  if (!plan || plan.refused || method?.kind !== "api-key" || !method.preset)
    throw new Error("This provider has no supported API-key contract");
  const preset = method.preset;
  const { profile, variantId } = selectedProfile(preset, supplied);
  const publicParameters = profile.templateParams
    .filter((field) => !field.secret)
    .map((field) => field.name);
  if (preset.credentialVariants.length)
    publicParameters.push("credential_variant");
  const privateCredentials = [
    "api_key",
    ...profile.templateParams
      .filter((field) => field.secret)
      .map((field) => field.name),
    ...profile.additionalCredentials.map((field) => field.name),
  ];
  if (Object.keys(supplied).some((name) => !publicParameters.includes(name)))
    throw new Error("Enter only this provider's public configuration fields");
  const parameters = publicInputs(profile, supplied, variantId);
  return {
    providerId,
    providerName: plan.name,
    profile,
    parameters,
    classification: { publicParameters, privateCredentials },
  };
}

function selectedProfile(
  preset: ApiKeyPreset,
  supplied: Record<string, string>,
) {
  const variantId =
    supplied.credential_variant ?? preset.credentialVariants[0]?.id;
  const profile = variantId
    ? preset.credentialVariants.find((entry) => entry.id === variantId)
    : preset;
  if (!profile?.auth || !profile.verify)
    throw new Error("Select a supported provider credential type");
  return { profile, variantId };
}
function publicInputValue(
  field: NativeApiProfile["templateParams"][number],
  supplied: Record<string, string>,
) {
  const value = supplied[field.name]?.trim() || field.choices?.[0]?.value || "";
  if (field.required && !value) throw new Error(`Enter ${field.label}`);
  if (
    value &&
    field.choices &&
    !field.choices.some((choice) => choice.value === value)
  )
    throw new Error(`Select a supported ${field.label}`);
  if (value.length > 256 || /[\r\n]/.test(value))
    throw new Error("Enter valid provider parameters");
  return value;
}
function publicInputs(
  profile: NativeApiProfile,
  supplied: Record<string, string>,
  variantId: string | undefined,
) {
  const parameters: Record<string, string> = {};
  if (variantId) parameters.credential_variant = variantId;
  for (const field of profile.templateParams.filter((entry) => !entry.secret))
    parameters[field.name] = publicInputValue(field, supplied);
  return parameters;
}

export function nativeApiCredentials(
  target: NativeApiTarget,
  supplied: Record<string, string>,
  retained: Record<string, string> = {},
): NativeApiCredentials {
  const known = target.classification.privateCredentials;
  if (Object.keys(supplied).some((name) => !known.includes(name)))
    throw new Error("Enter only this provider's private credential fields");
  const required = new Set([
    "api_key",
    ...target.profile.additionalCredentials
      .filter((field) => field.required)
      .map((field) => field.name),
    ...target.profile.templateParams
      .filter((field) => field.secret && field.required)
      .map((field) => field.name),
  ]);
  const result: Record<string, string> = {};
  for (const name of known) {
    const value = supplied[name]?.trim() || retained[name] || "";
    if (required.has(name) && !value)
      throw new Error("Enter the required provider credentials");
    if (value.length > 16384 || (value && !/^[!-~]+$/.test(value)))
      throw new Error("Enter valid provider credentials");
    if (value) result[name] = value;
  }
  return result;
}

export function providerTemplate(
  value: string,
  parameters: Record<string, string>,
  credentials: Record<string, string>,
  url = false,
): string {
  return value.replace(/\{([a-z_]+)\}/g, (_whole, name: string) => {
    const replacement =
      name === "key"
        ? credentials.api_key
        : (credentials[name] ?? parameters[name]);
    if (replacement === undefined || replacement === "")
      throw new Error("Complete the provider's required configuration");
    return url ? encodeURIComponent(replacement) : replacement;
  });
}

/** A machine's own loopback address: the one place a non-standard port is the person's. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(host)
  );
}

function assertTenantHosts(template: string, target: NativeApiTarget): void {
  const hostPart = template.slice("https://".length).split("/")[0] ?? "";
  for (const match of hostPart.matchAll(/\{([a-z_]+)\}/g)) {
    const name = match[1] ?? "";
    const value = target.parameters[name] ?? "";
    if (
      !target.classification.publicParameters.includes(name) ||
      !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(value) ||
      value.startsWith(".") ||
      value.endsWith(".")
    )
      throw new Error("Enter a valid provider tenant host");
    // A hostname-only contract keeps its hostname: a port belongs to the
    // machine's own loopback endpoint and nowhere else (the 443 rule below
    // still binds everything this check lets through).
    const port = value.indexOf(":");
    if (port >= 0 && !isLoopbackHost(value.slice(0, port)))
      throw new Error("Enter a valid provider tenant host");
  }
}

export function providerUrl(
  template: string,
  target: NativeApiTarget,
  credentials: Record<string, string>,
): URL {
  assertTenantHosts(template, target);
  const [hostPart = ""] = template.slice("https://".length).split("/");
  const hostFilled = template.replace(/\{([a-z_]+)\}/g, (whole, name) => {
    if (!hostPart.includes(whole)) return whole;
    return target.parameters[name] ?? "";
  });
  const url = new URL(
    providerTemplate(hostFilled, target.parameters, credentials, true),
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443" && !isLoopbackHost(url.hostname))
  )
    throw new Error("Provider requests require the compiled HTTPS target");
  return url;
}
