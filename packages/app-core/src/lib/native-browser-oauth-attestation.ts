/** Explicit human confirmation resolves an indeterminate exchange after provider-side revocation. */
import { connectPlan } from "./connect-plan.js";
import {
  browserOAuthClassification,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import type { NativeConfiguration } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { nativeDatabricksEndpoints } from "./native-databricks-provider.js";
import {
  NativeOAuthClientTarget,
  nativeOAuthClientClassification,
} from "./native-oauth-client-config.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  forgetRetainedNativeOAuthGrant,
  nativeOAuthGuard,
  nativeOAuthMutationInFlight,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { nativeOriginClassification } from "./native-origin-configuration.js";

export type NativeBrowserOAuthRevocationInstructions = {
  url: string;
  message: string;
  canConfirm: boolean;
};
function registered(configuration: NativeConfiguration): boolean {
  return (
    configuration.providerId !== "origin" &&
    configuration.method === "oauth" &&
    NativeOAuthClientTarget.keyof().options.some(
      (key) => key in configuration.parameters,
    )
  );
}
export function nativeBrowserOAuthRecoverySettings(
  configuration: NativeConfiguration,
): string | null {
  if (configuration.providerId === "origin" || registered(configuration))
    return (
      connectPlan(configuration.providerId)?.methods.find(
        (method) => method.kind === "oauth",
      )?.preset?.consoleUrl ?? ""
    );
  if (configuration.providerId === "databricks")
    return nativeDatabricksEndpoints(configuration.parameters.domain ?? "")
      .settings;
  return requiredBrowserOAuthProfile(configuration.providerId).settingsUrl;
}
type RecoveryEntry = ReturnType<
  typeof requireNativeOAuthRecord
>["privateState"]["recovery"][number];

function recoveryBusy(id: string, entry: RecoveryEntry): boolean {
  return (
    nativeOAuthMutationInFlight(id, entry.id) ||
    (["exchange", "refresh"].includes(entry.credentials?.phase ?? "") &&
      Number(entry.credentials?.deadline) > Date.now())
  );
}

function revocationMessage(
  configuration: NativeConfiguration,
  custom: boolean,
  isOrigin: boolean,
): string {
  const profile =
    custom || isOrigin
      ? null
      : requiredBrowserOAuthProfile(configuration.providerId);
  return custom || isOrigin
    ? "Revoke this registered OAuth application’s consent in the provider’s application settings. Confirm only after that provider action is complete. This confirmation clears the failed authorization; it does not verify a working connection."
    : profile?.id === "databricks"
      ? "Revoke this app’s consent in your Databricks workspace. Already issued tokens can remain valid until their expiry; confirming only forgets this browser’s saved credential and failed authorization."
      : `Open ${profile?.name} authorization settings and revoke the application or key for this connection. Confirm only after that provider action is complete. This confirmation clears the failed authorization; it does not verify a working connection.`;
}

export function nativeBrowserOAuthRevocationInstructions(
  id: string,
  recoveryId: string,
): NativeBrowserOAuthRevocationInstructions {
  const record = requireNativeOAuthRecord(id);
  const entry = record.privateState.recovery.find(
    (item) => item.id === recoveryId,
  );
  const custom = registered(record.configuration);
  const isOrigin = record.configuration.providerId === "origin";
  const settingsUrl = nativeBrowserOAuthRecoverySettings(record.configuration);
  if (
    !entry ||
    record.configuration.method !== "oauth" ||
    (!custom && !isOrigin && !settingsUrl)
  )
    throw new NativeOAuthError("cleanup");
  return {
    url: settingsUrl ?? "",
    message: revocationMessage(record.configuration, custom, isOrigin),
    canConfirm:
      !recoveryBusy(id, entry) &&
      entry.credentials?.phase !== "superseded" &&
      ["configure", "revoke"].includes(entry.kind),
  };
}
export async function attestNativeBrowserOAuthRevocation(
  id: string,
  recoveryId: string,
) {
  const instructions = nativeBrowserOAuthRevocationInstructions(id, recoveryId);
  if (!instructions.canConfirm) throw new NativeOAuthError("cleanup");
  const record = requireNativeOAuthRecord(id);
  const result = await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    record.configuration.providerId === "origin"
      ? nativeOriginClassification()
      : registered(record.configuration)
        ? nativeOAuthClientClassification()
        : browserOAuthClassification(record.configuration),
    (current) => {
      const entry = current.privateState.recovery.find(
        (item) => item.id === recoveryId,
      );
      if (
        !entry ||
        entry.credentials?.phase === "superseded" ||
        !["configure", "revoke"].includes(entry.kind)
      )
        throw new NativeOAuthError("cleanup");
      current.privateState.recovery = current.privateState.recovery.filter(
        (item) => item.id !== recoveryId,
      );
      current.privateState.verification = null;
      current.runtime.verifiedAt = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
  forgetRetainedNativeOAuthGrant(id, recoveryId);
  return result;
}
