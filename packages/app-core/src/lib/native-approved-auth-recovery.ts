/** Unobserved provider replies remain an explicit sealed outcome, never a revocation claim. */
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
export async function recordApprovedNativeExchangeFailure(
  id: string,
  intentId: string,
  error: Error,
) {
  const record = requireNativeOAuthRecord(id);
  if (!["databricks", "discord"].includes(record.configuration.providerId))
    return;
  const denied =
    error instanceof NativeOAuthError &&
    (error.code === "denied" || !!error.oauthError);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      const entry = current.privateState.recovery.find(
        (item) => item.id === intentId,
      );
      if (!entry || (entry.grant && entry.credentials?.phase !== "refresh"))
        return current;
      entry.credentials = {
        ...entry.credentials,
        phase: denied ? "exchange-denied" : "exchange-unobserved",
        deadline: "0",
      };
      current.configuration.parameters.authorization_outcome = denied
        ? "denied"
        : "exchange-unobserved";
      return current;
    },
  );
}
