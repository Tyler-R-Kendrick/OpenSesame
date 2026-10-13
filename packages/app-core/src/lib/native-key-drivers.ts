/**
 * Every provider family that connects from the browser with the person's own
 * key (ADR 0198). The connection form, the runtime and the cleanup all find a
 * provider here; adding a family is adding its flows to this list.
 */
import { acmeKeyFlows } from "./native-acme.js";
import { awsKeyFlows } from "./native-aws.js";
import { azureAcKeyFlows } from "./native-azure-ac.js";
import { gcpIamKeyFlows, gcpKeyFlows } from "./native-gcp.js";
import { infisicalKeyFlows } from "./native-infisical.js";
import type { NativeKeyFlows } from "./native-key-driver.js";
import { stsKeyFlows } from "./native-sts.js";

export const NATIVE_KEY_DRIVERS: readonly NativeKeyFlows[] = [
  awsKeyFlows,
  stsKeyFlows,
  azureAcKeyFlows,
  gcpKeyFlows,
  gcpIamKeyFlows,
  acmeKeyFlows,
  infisicalKeyFlows,
];

export function nativeKeyDriverFor(providerId: string): NativeKeyFlows | null {
  return (
    NATIVE_KEY_DRIVERS.find((driver) => driver.accepts(providerId)) ?? null
  );
}
