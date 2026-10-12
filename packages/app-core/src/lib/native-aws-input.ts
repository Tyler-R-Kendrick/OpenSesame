/**
 * What a browser may be asked to connect to on AWS (ADR 0197): two secret
 * stores, each at the endpoint AWS publishes for a region, signed with the
 * person's own access key. The endpoint is compiled from the region and the
 * service — never typed — so a connection cannot be pointed at an address
 * this table does not name (ADR 0185 §8).
 */
import { canonicalize } from "@opensesame/os-domain";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";

/** The AWS services reachable from a browser, by catalog id. */
export const NATIVE_AWS_SERVICES = {
  aws: {
    name: "AWS Secrets Manager",
    /** The name AWS signs this service under, and its JSON target prefix. */
    service: "secretsmanager",
    targetPrefix: "secretsmanager",
    /** What a secret is called, for the one read this connection offers. */
    allowedName: /^[A-Za-z0-9/_+=.@-]{1,512}$/,
  },
  "aws-ps": {
    name: "AWS Parameter Store",
    service: "ssm",
    targetPrefix: "AmazonSSM",
    allowedName: /^[A-Za-z0-9_./-]{1,1011}$/,
  },
} as const;

export type NativeAwsProviderId = keyof typeof NATIVE_AWS_SERVICES;

export function isNativeAwsProvider(id: string): id is NativeAwsProviderId {
  return Object.hasOwn(NATIVE_AWS_SERVICES, id);
}

export const nativeAwsClassification = {
  publicParameters: ["region", "access_key_id"],
  privateCredentials: ["secret_access_key", "session_token"],
};

export type NativeAwsTarget = {
  providerId: NativeAwsProviderId;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
};

/** A commercial or GovCloud region, e.g. `us-east-1`, `eu-central-2`, `us-gov-west-1`. */
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** The endpoint AWS publishes for this service in this region. */
export function nativeAwsEndpoint(
  providerId: NativeAwsProviderId,
  region: string,
): URL {
  if (!REGION.test(region)) throw new Error("Enter a valid AWS region");
  return new URL(
    `https://${NATIVE_AWS_SERVICES[providerId].service}.${region}.amazonaws.com/`,
  );
}

/** Nothing but a region and a key: no endpoint, no scope, no target, no extra field. */
function assertOnlyAwsFields(
  input: NativeApiConfigureInput,
): NativeAwsProviderId {
  const providerId = input.providerId;
  if (
    !isNativeAwsProvider(providerId) ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length
  )
    throw new Error("Configure only an AWS region and its access key");
  if (
    Object.keys(input.parameters).some(
      (key) => !nativeAwsClassification.publicParameters.includes(key),
    ) ||
    Object.keys(input.credentials).some(
      (key) => !nativeAwsClassification.privateCredentials.includes(key),
    )
  )
    throw new Error("Unsupported AWS configuration field");
  return providerId;
}

function publicParameters(
  input: NativeApiConfigureInput,
  providerId: NativeAwsProviderId,
): Record<string, string> {
  const parameters = Object.fromEntries(
    nativeAwsClassification.publicParameters.map((key) => [
      key,
      (input.parameters[key] ?? "").trim(),
    ]),
  );
  nativeAwsEndpoint(providerId, parameters.region ?? "");
  if (!/^[A-Z0-9]{16,128}$/.test(parameters.access_key_id ?? ""))
    throw new Error("Enter a valid AWS access key ID");
  return parameters;
}

function signingCredentials(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): Record<string, string> {
  const credentials = Object.fromEntries(
    nativeAwsClassification.privateCredentials.map((key) => [
      key,
      input.credentials[key] || saved?.privateState.credentials[key] || "",
    ]),
  );
  // A new secret key replaces the session token it was issued with.
  if (input.credentials.secret_access_key && !input.credentials.session_token)
    credentials.session_token = "";
  if (
    !credentials.secret_access_key ||
    Object.values(credentials).some(
      (value) => value.length > 16384 || (value && !/^[!-~]+$/.test(value)),
    )
  )
    throw new Error("Enter valid AWS signing credentials");
  return credentials;
}

export function nativeAwsInput(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeAwsTarget {
  const providerId = assertOnlyAwsFields(input);
  const parameters = publicParameters(input, providerId);
  const credentials = signingCredentials(input, saved);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, credentials);
  return { providerId, parameters, credentials };
}

/** Binds a saved connection to its service, region and key; a changed one is a new connection. */
export async function nativeAwsFingerprint(
  providerId: NativeAwsProviderId,
  parameters: Record<string, string>,
) {
  const bytes = new TextEncoder().encode(
    canonicalize({ contract: `aws:sigv4:${providerId}:v1`, parameters }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The AWS service a saved connection names; anything else is not this driver's. */
export function nativeAwsProviderOf(providerId: string): NativeAwsProviderId {
  if (!isNativeAwsProvider(providerId))
    throw new Error("This is not an AWS connection");
  return providerId;
}
