/**
 * What a browser may be asked to connect to on AWS (ADR 0197): two secret
 * stores, each at the endpoint AWS publishes for a region, signed with the
 * person's own access key. The endpoint is compiled from the region and the
 * service — never typed — so a connection cannot be pointed at an address
 * this table does not name (ADR 0185 §8).
 */
import { canonicalize } from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
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

export type NativeAwsServiceId = keyof typeof NATIVE_AWS_SERVICES;

const SERVICE_IDS: readonly NativeAwsServiceId[] = ["aws", "aws-ps"];

/**
 * The AWS service a provider id names. The app keeps the id it was asked for,
 * and an alias such as `aws-secrets-manager` is the id stored connections use,
 * so this resolves the catalog's own alias table rather than a second list.
 */
export function nativeAwsServiceId(
  providerId: string,
): NativeAwsServiceId | null {
  const canonical = canonicalProviderId(providerId);
  return SERVICE_IDS.find((id) => id === canonical) ?? null;
}

export function isNativeAwsProvider(providerId: string): boolean {
  return nativeAwsServiceId(providerId) !== null;
}

/** The AWS service a saved connection names; anything else is not this driver's. */
export function nativeAwsServiceOf(providerId: string): NativeAwsServiceId {
  const service = nativeAwsServiceId(providerId);
  if (!service) throw new Error("This is not an AWS connection");
  return service;
}

export const nativeAwsClassification = {
  publicParameters: ["region", "access_key_id"],
  privateCredentials: ["secret_access_key", "session_token"],
};

export type NativeAwsTarget = {
  /** The id the connection is stored under: the alias the app was asked for. */
  providerId: string;
  service: NativeAwsServiceId;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
};

/** A commercial or GovCloud region, e.g. `us-east-1`, `eu-central-2`, `us-gov-west-1`. */
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** The endpoint AWS publishes for this signing-service name in this region. */
export function nativeAwsRegionalEndpoint(host: string, region: string): URL {
  if (!REGION.test(region)) throw new Error("Enter a valid AWS region");
  return new URL(`https://${host}.${region}.amazonaws.com/`);
}

/** The endpoint AWS publishes for this service in this region. */
export function nativeAwsEndpoint(
  service: NativeAwsServiceId,
  region: string,
): URL {
  return nativeAwsRegionalEndpoint(
    NATIVE_AWS_SERVICES[service].service,
    region,
  );
}

/** Nothing but a region and a key: no endpoint, no scope, no target, no extra field. */
export function assertOnlyAwsFields(
  input: NativeApiConfigureInput,
  ours: boolean,
): void {
  if (
    !ours ||
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
}

/** The region and key id, trimmed, with the region checked against the shape AWS publishes. */
export function awsPublicParameters(
  input: NativeApiConfigureInput,
): Record<string, string> {
  const parameters = Object.fromEntries(
    nativeAwsClassification.publicParameters.map((key) => [
      key,
      (input.parameters[key] ?? "").trim(),
    ]),
  );
  nativeAwsRegionalEndpoint("sts", parameters.region ?? "");
  if (!/^[A-Z0-9]{16,128}$/.test(parameters.access_key_id ?? ""))
    throw new Error("Enter a valid AWS access key ID");
  return parameters;
}

/** The secret key and optional session token, the saved ones where the form left them blank. */
export function awsSigningCredentials(
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
  const service = nativeAwsServiceId(input.providerId);
  assertOnlyAwsFields(input, service !== null);
  if (!service) throw new Error("This is not an AWS connection");
  const parameters = awsPublicParameters(input);
  const credentials = awsSigningCredentials(input, saved);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, credentials);
  return { providerId: input.providerId, service, parameters, credentials };
}

/** Binds a saved connection to its service, region and key; a changed one is a new connection. */
export async function nativeAwsFingerprint(
  service: NativeAwsServiceId,
  parameters: Record<string, string>,
) {
  const bytes = new TextEncoder().encode(
    canonicalize({ contract: `aws:sigv4:${service}:v1`, parameters }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
