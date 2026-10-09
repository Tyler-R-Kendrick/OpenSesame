/** Explicit human confirmation resolves an indeterminate exchange after provider-side revocation. */
import {
  browserOAuthClassification,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  forgetRetainedNativeOAuthGrant,
  nativeOAuthGuard,
  nativeOAuthMutationInFlight,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

export type NativeBrowserOAuthRevocationInstructions = {
  url: string;
  message: string;
  canConfirm: boolean;
};
export function nativeBrowserOAuthRevocationInstructions(
  id: string,
  recoveryId: string,
): NativeBrowserOAuthRevocationInstructions {
  const record = requireNativeOAuthRecord(id);
  const entry = record.privateState.recovery.find(
    (item) => item.id === recoveryId,
  );
  const profile = requiredBrowserOAuthProfile(record.configuration.providerId);
  if (!entry || record.configuration.method !== "oauth" || !profile.settingsUrl)
    throw new NativeOAuthError("cleanup");
  const busy =
    nativeOAuthMutationInFlight(id, entry.id) ||
    (["exchange", "refresh"].includes(entry.credentials?.phase ?? "") &&
      Number(entry.credentials?.deadline) > Date.now());
  return {
    url: profile.settingsUrl,
    message: `Open ${profile.name} authorization settings and revoke the application or key for this connection. Confirm only after that provider action is complete. This confirmation clears the failed authorization; it does not verify a working connection.`,
    canConfirm: !busy && ["configure", "revoke"].includes(entry.kind),
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
    browserOAuthClassification(record.configuration),
    (current) => {
      const entry = current.privateState.recovery.find(
        (item) => item.id === recoveryId,
      );
      if (!entry || !["configure", "revoke"].includes(entry.kind))
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
