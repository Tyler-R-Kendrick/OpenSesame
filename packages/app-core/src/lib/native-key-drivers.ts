/**
 * Every provider family that connects from the browser with the person's own
 * key (ADR 0198). The connection form, the runtime and the cleanup all find a
 * provider here; adding a family is adding its flows to this list.
 */
import { acmeKeyFlows } from "./native-acme.js";
import { awsKeyFlows } from "./native-aws.js";
import { azureAcKeyFlows } from "./native-azure-ac.js";
import { azureSecretsKeyFlows } from "./native-azure-secrets.js";
import { gcpIamKeyFlows, gcpKeyFlows } from "./native-gcp.js";
import { googleWalletKeyFlows } from "./native-google-wallet.js";
import { infisicalKeyFlows } from "./native-infisical.js";
import type { NativeKeyFlows } from "./native-key-driver.js";
import { snowflakeKeyFlows } from "./native-snowflake.js";
import { stsKeyFlows } from "./native-sts.js";

export const NATIVE_KEY_DRIVERS: readonly NativeKeyFlows[] = [
  awsKeyFlows,
  stsKeyFlows,
  azureAcKeyFlows,
  azureSecretsKeyFlows,
  gcpKeyFlows,
  gcpIamKeyFlows,
  acmeKeyFlows,
  infisicalKeyFlows,
  snowflakeKeyFlows,
  googleWalletKeyFlows,
];

export function nativeKeyDriverFor(providerId: string): NativeKeyFlows | null {
  return (
    NATIVE_KEY_DRIVERS.find((driver) => driver.accepts(providerId)) ?? null
  );
}
