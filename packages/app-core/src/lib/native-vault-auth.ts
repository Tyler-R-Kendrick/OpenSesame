import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
/** A minted Vault token is durably journaled, verified, then atomically activated. */
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { lookupNativeLocalInstance } from "./native-local-instance-http.js";
import {
  claimNativeOAuthPending,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
} from "./native-oauth-session.js";
import { commitNativeVaultGrant } from "./native-vault-commit.js";
import { vaultExchangeOidc } from "./native-vault-http.js";
import {
  prepareVaultExchange,
  recordVaultExchangeFailure,
  vaultExchangeDenied,
} from "./native-vault-intent.js";
import {
  cancelNativeVaultOidc,
  nativeVaultClassification,
  nativeVaultInput,
  requireNativeVault,
} from "./native-vault-session.js";

async function completionTransport(
  connectionId: string,
  state: string,
  base: NativeProviderTransport,
) {
  try {
    const current = captureNativeAuthorizationTransport(base);
    current.assertCurrent();
    return current;
  } catch (error) {
    await cancelNativeVaultOidc(connectionId, state);
    throw error;
  }
}
export async function completeNativeVaultOidc(
  connectionId: string,
  callback: { state: string; code: string },
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const authTransport = await completionTransport(
    connectionId,
    callback.state,
    transport,
  );
  const initial = requireNativeVault(connectionId);
  if (initial.privateState.pending.user?.state !== callback.state)
    throw new Error("This authorization belongs to another browser connection");
  const nonce = initial.privateState.credentials.oidc_nonce;
  if (!nonce)
    throw new Error("The authorization request is no longer available");
  const search = new URLSearchParams({
    native_state: callback.state,
    native_code: callback.code,
  }).toString();
  const claim = await claimNativeOAuthPending(
    search,
    nativeVaultClassification,
  );
  await prepareVaultExchange(connectionId, claim.obligation.id);
  let minted = false;
  const finish = markNativeOAuthMutationInFlight(
    connectionId,
    claim.obligation.id,
  );
  try {
    const input = nativeVaultInput(connectionId);
    const issued = await vaultExchangeOidc(
      input,
      {
        state: claim.pending.state,
        code: claim.code,
        nonce,
        clientNonce: claim.pending.verifier,
      },
      authTransport,
    );
    minted = true;
    const grant = {
      providerId: input.providerId,
      actor: "user",
      fingerprint: claim.pending.fingerprint,
      kind: "oidc" as const,
      accessToken: issued.accessToken,
      expiresAt: issued.expiresAt,
      scopes: null,
      endpoint: input.endpoint,
    };
    await journalNativeOAuthGrant(
      connectionId,
      claim.obligation.id,
      grant,
      () => nativeVaultClassification,
      { namespace: input.namespace },
    );
    authTransport.assertCurrent();
    const facts = await lookupNativeLocalInstance(
      input.endpoint,
      input.namespace,
      issued.accessToken,
      authTransport,
    );
    const saved = await commitNativeVaultGrant(
      connectionId,
      claim.obligation.id,
      claim.pending.state,
      grant,
      facts,
      input,
      authTransport,
    );
    return saved.recovery.length
      ? retryNativeConnectorCleanup(connectionId)
      : saved;
  } catch (error) {
    if (!minted) {
      await recordVaultExchangeFailure(
        connectionId,
        claim.obligation.id,
        error instanceof Error && vaultExchangeDenied(error),
      );
    }
    finish();
    await retryNativeConnectorCleanup(connectionId).catch(() => undefined);
    throw error;
  } finally {
    finish();
  }
}
