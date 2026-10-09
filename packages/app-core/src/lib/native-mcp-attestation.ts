/** Human provider-side recovery resolves uncertainty; it never asserts a working connection. */
import { connectPlan } from "./connect-plan.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import {
  MCP_CLASSIFICATION,
  nativeMcpProviderMetadata,
} from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { forgetRetainedNativeMcpRegistration } from "./native-mcp-registration.js";
import {
  forgetRetainedNativeOAuthGrant,
  nativeOAuthGuard,
  nativeOAuthMutationInFlight,
} from "./native-oauth-session.js";

export type NativeMcpRevocationGuide = {
  url: string;
  message: string;
  canConfirm: boolean;
};

export function nativeMcpRevocationInstructions(
  id: string,
  recoveryId: string,
): NativeMcpRevocationGuide {
  const record = requireNativeMcpRecord(id);
  const entry = record.privateState.recovery.find(
    (candidate) => candidate.id === recoveryId,
  );
  const plan = connectPlan(record.configuration.providerId);
  if (
    !entry ||
    !plan ||
    !["registration", "configure", "revoke"].includes(entry.kind)
  )
    throw new NativeMcpAuthError("pending");
  const metadata = nativeMcpProviderMetadata(
    record.configuration.providerId,
    record.configuration.parameters.mcp_url,
  );
  const registration =
    metadata.status === "ok" && metadata.registration === "dcr";
  const busy =
    nativeOAuthMutationInFlight(id, recoveryId) ||
    (["registration", "exchange", "refresh"].includes(
      entry.credentials?.phase ?? "",
    ) &&
      Number(entry.credentials?.deadline) > Date.now());
  return {
    url: plan.docsUrl ?? metadata.url,
    message: `Open ${plan.name}'s official documentation and authorization settings. Revoke application access for this connection${registration ? " and remove its OpenSesame public client registration" : ""}. Confirm only after completing that provider action. This human confirmation clears local authorization; it does not verify provider revocation or a working connection.`,
    canConfirm: !busy,
  };
}
export async function attestNativeMcpRevocation(
  id: string,
  recoveryId: string,
) {
  if (!nativeMcpRevocationInstructions(id, recoveryId).canConfirm)
    throw new NativeMcpAuthError("pending");
  const initial = requireNativeMcpRecord(id);
  const result = await updateNativeConnector(
    id,
    nativeOAuthGuard(initial),
    MCP_CLASSIFICATION,
    (record) => {
      const entry = record.privateState.recovery.find(
        (candidate) => candidate.id === recoveryId,
      );
      if (!entry || nativeOAuthMutationInFlight(id, recoveryId))
        throw new NativeMcpAuthError("pending");
      record.privateState.recovery = record.privateState.recovery.filter(
        (candidate) => candidate.id !== recoveryId,
      );
      record.privateState.grants = {};
      record.privateState.pending = {};
      record.privateState.credentials = {};
      record.privateState.verification = null;
      record.runtime.verifiedAt = null;
      record.runtime.grants = [];
      return record;
    },
  );
  forgetRetainedNativeOAuthGrant(id, recoveryId);
  forgetRetainedNativeMcpRegistration(id, recoveryId);
  return result;
}
