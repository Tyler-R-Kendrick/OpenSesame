import { canonicalize } from "@opensesame/os-domain";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";

export const nativeS3Classification = {
  publicParameters: ["endpoint", "region", "bucket", "access_key_id", "prefix"],
  privateCredentials: ["secret_access_key", "session_token"],
};
export type NativeS3Target = {
  parameters: Record<string, string>;
  credentials: Record<string, string>;
};

export function nativeS3Input(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeS3Target {
  if (
    input.providerId !== "s3" ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length
  )
    throw new Error("Configure only an S3 bucket and its credentials");
  if (
    Object.keys(input.parameters).some(
      (key) => !nativeS3Classification.publicParameters.includes(key),
    ) ||
    Object.keys(input.credentials).some(
      (key) => !nativeS3Classification.privateCredentials.includes(key),
    )
  )
    throw new Error("Unsupported S3 configuration field");
  const parameters = Object.fromEntries(
    nativeS3Classification.publicParameters.map((key) => [
      key,
      (input.parameters[key] ?? "").trim(),
    ]),
  );
  parameters.prefix = input.parameters.prefix ?? "";
  validateParameters(parameters);
  const credentials = Object.fromEntries(
    nativeS3Classification.privateCredentials.map((key) => [
      key,
      input.credentials[key] || saved?.privateState.credentials[key] || "",
    ]),
  );
  if (input.credentials.secret_access_key && !input.credentials.session_token)
    credentials.session_token = "";
  validateCredentials(credentials);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, credentials);
  return { parameters, credentials };
}

function validateParameters(parameters: Record<string, string>) {
  parameters.endpoint = validatedEndpoint(parameters.endpoint ?? "");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(parameters.bucket ?? "") ||
    !/^[a-z0-9-]{1,64}$/.test(parameters.region ?? "") ||
    !/^[!-~]{1,256}$/.test(parameters.access_key_id ?? "")
  )
    throw new Error("Enter a valid S3 bucket, region and access key ID");
  const prefix = parameters.prefix ?? "";
  if (
    prefix.length > 512 ||
    !/^[^\p{Cc}]*$/u.test(prefix) ||
    prefix.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Enter a valid S3 object prefix");
}

function validatedEndpoint(value: string) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    endpoint.origin.length > 180
  )
    throw new Error(
      "Enter an HTTPS S3 service origin without credentials or a path",
    );
  return endpoint.origin;
}

function validateCredentials(credentials: Record<string, string>) {
  if (
    !credentials.secret_access_key ||
    Object.values(credentials).some(
      (value) => value.length > 16384 || (value && !/^[!-~]+$/.test(value)),
    )
  )
    throw new Error("Enter valid S3 signing credentials");
}

export async function nativeS3Fingerprint(parameters: Record<string, string>) {
  const bytes = new TextEncoder().encode(
    canonicalize({ contract: "s3:sigv4:ListObjectsV2:v1", parameters }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
