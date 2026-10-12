/** Provider verification produces an allowlisted view, never upstream JSON. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { ProviderVerification } from "./connect-provider-auth-schema.js";
import { NativeApiError } from "./native-api-http.js";
import { NativeConfigurationSchema } from "./native-connector-schema.js";

export type NativeApiReadResult = {
  label: string;
  items: { id: string; label: string; url?: string }[];
};
export function providerField(
  body: BoundaryValue,
  path: string,
): BoundaryValue | undefined {
  let value: BoundaryValue | undefined = body;
  for (const key of path.split(".")) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      return undefined;
    if (Array.isArray(value)) value = value[Number(key)];
    else if (isJsonObject(value)) value = value[key];
    else return undefined;
  }
  return value;
}
export function safeProviderText(
  value: string,
  credentials: Record<string, string>,
): string {
  if (
    value.length > 4096 ||
    Object.values(credentials).some(
      (secret) => secret && value.includes(secret),
    )
  )
    throw new NativeApiError("response");
  return value;
}
/** Icon bytes use the exact image contract; provider text retains its smaller limit. */
export function safeNativeConnectorIcon(
  value: string,
  credentials: Record<string, string>,
): string {
  if (
    !NativeConfigurationSchema.pick({ icon: true }).safeParse({ icon: value })
      .success ||
    Object.values(credentials).some(
      (secret) => secret && value.includes(secret),
    )
  )
    throw new NativeApiError("response");
  return value;
}
function hasProviderError(value: BoundaryValue | undefined): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0)
  );
}
export function verifyNativeApiResponse(
  providerName: string,
  verify: ProviderVerification,
  body: BoundaryValue,
  credentials: Record<string, string>,
): NativeApiReadResult {
  if (!Array.isArray(body) && !isJsonObject(body))
    throw new NativeApiError("response");
  for (const path of new Set(["error", "errors", ...verify.errorFields]))
    if (hasProviderError(providerField(body, path)))
      throw new NativeApiError("authorization");
  for (const condition of verify.success)
    if (providerField(body, condition.field) !== condition.equals)
      throw new NativeApiError("authorization");
  for (const path of verify.requiredFields) {
    const value = providerField(body, path);
    if (value === undefined || value === null || value === "")
      throw new NativeApiError("response");
  }
  const account = verify.accountField
    ? providerField(body, verify.accountField)
    : undefined;
  const label =
    isString(account) && account
      ? safeProviderText(account, credentials)
      : `${providerName} API access verified`;
  return { label, items: [] };
}
