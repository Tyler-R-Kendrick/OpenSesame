/** Human provider-side recovery resolves uncertainty; it never asserts a working connection. */
import { connectPlan } from "./connect-plan.js";
import {
  assertNativeConnectorRevision,
  updateNativeConnector,
} from "./native-connector-store.js";
import { withNativeMcpMutationLock } from "./native-mcp-mutation-lock.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { forgetRetainedNativeMcpPartialRefresh } from "./native-mcp-partial-refresh.js";
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
  revision: number;
};

function buildGuide(id: string, recoveryId: string): NativeMcpRevocationGuide {
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
    record.privateState.recovery.some((candidate) =>
      ["registration", "exchange", "refresh"].includes(
        candidate.credentials?.phase ?? "",
      ),
    );
  const where = plan.docsUrl
    ? `Open ${plan.name}'s official documentation and authorization settings`
    : `Open the MCP server address this connection used (no documentation link is known for ${plan.name}) and find its authorization settings in your ${plan.name} account`;
  return {
    url: plan.docsUrl ?? metadata.url,
    message: `${where}. Revoke application access for this connection${registration ? " and remove its OpenSesame public client registration" : ""}. Confirm only after completing that provider action. Uncertain issuance remains in recovery because the provider could still finish a submitted request. Confirmation clears local authorization only for settled obligations; it does not verify provider revocation or a working connection.`,
    canConfirm: !busy,
    revision: record.revision,
  };
}
export async function nativeMcpRevocationInstructions(
  id: string,
  recoveryId: string,
): Promise<NativeMcpRevocationGuide> {
  return withNativeMcpMutationLock(id, async () => {
    const initial = requireNativeMcpRecord(id);
    await assertNativeConnectorRevision(id, nativeOAuthGuard(initial));
    return buildGuide(id, recoveryId);
  });
}
export async function attestNativeMcpRevocation(
  id: string,
  recoveryId: string,
  revision: number,
) {
  return withNativeMcpMutationLock(id, async () => {
    if (!buildGuide(id, recoveryId).canConfirm)
      throw new NativeMcpAuthError("pending");
    const initial = requireNativeMcpRecord(id);
    if (initial.revision !== revision) throw new NativeMcpAuthError("pending");
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
    forgetRetainedNativeMcpPartialRefresh(id, recoveryId);
    forgetRetainedNativeOAuthGrant(id, recoveryId);
    forgetRetainedNativeMcpRegistration(id, recoveryId);
    return result;
  });
}
