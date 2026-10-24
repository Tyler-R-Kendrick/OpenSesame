/** A verified native identity follows the same vault and account-link outcomes as an OIDC return. */
import { currentAuthGeneration } from "./auth-generation.js";
import { storeAuthOutcome } from "./auth-outcome.js";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { resolveIdentityBase } from "./device-identity.js";
import { assertConfiguredIdentitySessionTrusted } from "./federation-configured-token.js";
import {
  type FederationSessionGeneration,
  federationSessionGeneration,
} from "./federation-native-session.js";
import {
  type UpstreamIdentity,
  displayName,
  saveSession,
} from "./federation.js";
import { adoptFederatedIdentity, openVaultAfterSignIn } from "./guest-auth.js";
import { identityConnectionRevision } from "./identity-connections-store.js";
import { currentSession, subscribeIdentitySession } from "./identity.js";
import { vaultStore } from "./vault/store.js";

export type ConfiguredIdentitySessionOwner = Readonly<{
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
  release: () => void;
}>;

/** A pending HTTP assertion cannot cross a sign-out, actor or vault transition. */
class OriginalConfiguredIdentitySessionOwner {
  readonly generation = federationSessionGeneration();
  readonly authGeneration = currentAuthGeneration();
  readonly actor = currentSession();
  readonly realm = resolveIdentityBase();
  readonly vault = this.vaultContext();
  readonly revision: string | null;
  readonly subscriptions: (() => void)[] = [];
  retired = false;

  constructor(readonly connectionId: string) {
    this.revision = identityConnectionRevision(connectionId);
    this.subscriptions.push(
      vaultStore.onLock(this.release),
      vaultStore.subscribe(this.observe),
      subscribeIdentitySession(this.observe),
      subscribeDeviceRows(this.observe),
    );
  }
  vaultContext(): string {
    const { tomb, status, guest, header, awaitingSecondStep } =
      vaultStore.getSnapshot();
    return JSON.stringify({ tomb, status, guest, header, awaitingSecondStep });
  }
  assertCurrent = (): void => {
    if (
      this.vaultContext() !== this.vault ||
      identityConnectionRevision(this.connectionId) !== this.revision
    )
      throw new Error(
        "The original vault or identity configuration changed. Start again.",
      );
    if (
      this.retired ||
      federationSessionGeneration() !== this.generation ||
      currentAuthGeneration() !== this.authGeneration ||
      currentSession() !== this.actor ||
      resolveIdentityBase() !== this.realm
    )
      throw new Error(
        "The original identity sign-in owner changed. Start again.",
      );
  };
  observe = (): void => {
    try {
      this.assertCurrent();
    } catch {
      this.release();
    }
  };
  release = (): void => {
    this.retired = true;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  };
}

/** Capture synchronously before the direct provider's first HTTP request. */
export function captureConfiguredIdentitySessionOwner(
  connectionId: string,
): ConfiguredIdentitySessionOwner {
  const original = new OriginalConfiguredIdentitySessionOwner(connectionId);
  return Object.freeze({
    generation: original.generation,
    assertCurrent: original.assertCurrent,
    release: original.release,
  });
}

export async function admitConfiguredIdentitySession(
  identity: UpstreamIdentity,
  owner: ConfiguredIdentitySessionOwner,
): Promise<void> {
  assertConfiguredIdentitySessionTrusted(identity);
  owner.assertCurrent();
  saveSession(identity, owner.generation);
  // Admission may legitimately create the original empty vault; the pending
  // HTTP owner ends exactly when its generation-checked assertion is saved.
  owner.release();
  const adopted = await adoptFederatedIdentity(identity.idToken);
  const inApp = await openVaultAfterSignIn();
  if (inApp || adopted.kind === "pending_link") return;
  storeAuthOutcome(
    adopted.kind === "linked" || adopted.kind === "local"
      ? { kind: "linked", who: displayName(identity) }
      : {
          kind: "link_failed",
          who: displayName(identity),
          detail: adopted.reason,
        },
  );
}
