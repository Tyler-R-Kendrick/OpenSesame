import { sha256Base64Url } from "@opensesame/sdk-browser";
import { updateNativeConnector } from "./native-connector-store.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  claimNativeOAuthPending,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  type NativeOriginOwner,
  assertNativeOriginPolicy,
  initializeNativeOriginCustody,
  nativeOriginClassification,
  nativeOriginTarget,
  readNativeOriginPrivateKey,
} from "./native-origin-configuration.js";
import { verifyNativeOriginReceipt } from "./native-origin-receipt.js";
import { mintNativeOriginInstallationToken } from "./native-origin-token.js";

async function discardUnissued(
  id: string,
  revision: number,
  fingerprint: string,
  intentId: string,
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  if (record.revision !== revision) throw new NativeOAuthError("expired");
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeOriginClassification(),
    (current) => {
      const intent = current.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (
        !intent ||
        intent.fingerprint !== fingerprint ||
        intent.grant ||
        intent.credentials?.phase !== "exchange"
      )
        throw new NativeOAuthError("expired");
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      return current;
    },
  );
}
export async function exchangeNativeOriginInstallation(
  search: string,
  owner: NativeOriginOwner,
): Promise<void> {
  await initializeNativeOriginCustody();
  const claim = await claimNativeOAuthPending(
    search,
    nativeOriginClassification(),
  );
  const id = claim.record.connectionId;
  const target = nativeOriginTarget(claim.record.configuration);
  const pending = claim.pending;
  if (
    pending.endpoint !== target.token_endpoint ||
    pending.issuer !== target.issuer ||
    pending.resource !== target.resource ||
    pending.clientId !== target.clientId ||
    pending.redirectUri !== target.redirectUri ||
    pending.verifier !== ""
  )
    throw new NativeOAuthError("expired");
  assertNativeOriginPolicy(claim.record.configuration, owner);
  const privateKey = readNativeOriginPrivateKey(id, owner);
  const digest = await sha256Base64Url(privateKey);
  if (
    claim.record.privateState.credentials.origin_app_consent !==
    `${pending.state}:${digest}`
  )
    throw new NativeOAuthError("expired");
  let receipt: Awaited<ReturnType<typeof verifyNativeOriginReceipt>>;
  try {
    receipt = await verifyNativeOriginReceipt(claim.code, {
      configuration: claim.record.configuration,
      appId: target.clientId,
      state: pending.state,
      owner,
    });
  } catch (error) {
    await discardUnissued(
      id,
      claim.record.revision,
      pending.fingerprint,
      claim.obligation.id,
    );
    throw error;
  }
  const release = markNativeOAuthMutationInFlight(id, claim.obligation.id);
  try {
    const grant = await mintNativeOriginInstallationToken({
      connectionId: id,
      configuration: claim.record.configuration,
      installationId: receipt.installationId,
      scopes: pending.scopes,
      owner,
      check: () => {
        const current = requireNativeOAuthRecord(id);
        if (
          current.revision !== claim.record.revision ||
          current.configuration.fingerprint !== pending.fingerprint ||
          readNativeOriginPrivateKey(id, owner) !== privateKey
        )
          throw new NativeOAuthError("expired");
      },
    });
    await journalNativeOAuthGrant(
      id,
      claim.obligation.id,
      grant,
      nativeOriginClassification,
      {
        protocol_valid: "true",
        requested_scopes: JSON.stringify(pending.scopes),
        installation_id: receipt.installationId,
        namespace_id: receipt.namespaceId,
        receipt_id: receipt.receiptId,
      },
    );
  } finally {
    release();
  }
}
