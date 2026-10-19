/** Native protocol evidence authenticates identity; these guards only retain its original local lineage. */
import { currentAuthGeneration } from "./auth-generation.js";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { resolveIdentityBase } from "./device-identity.js";
import { federationSessionGeneration } from "./federation-native-session.js";
import type { IdentityConnectionDraft } from "./identity-connections-schema.js";
import {
  getIdentityConnectionRuntime,
  identityConnectionRevision,
} from "./identity-connections-store.js";
import { currentSession, subscribeIdentitySession } from "./identity.js";
import { signInMethods, subscribeSettings } from "./settings.js";
import { vaultStore } from "./vault/store.js";

export type NativeIdentityProtocol = "saml" | "oidc" | "ldap";
export type NativeIdentityTarget = Readonly<{
  issuer: string;
  audience: string;
}>;
export type NativeIdentityTargetResolver = (
  draft: IdentityConnectionDraft,
) => NativeIdentityTarget;
export type NativeIdentityOwner = Readonly<{
  signal: AbortSignal;
  assertPending: () => void;
  bindConfiguration: (draft: IdentityConnectionDraft) => void;
  /** A guarded synchronous native session-port installation may advance its own generation. */
  prepareRuntime: (install: () => void) => void;
  assertSessionCurrent: (issuer: string, audience: string) => void;
  release: () => void;
}>;
function credentialMaterial(
  header: ReturnType<typeof vaultStore.getSnapshot>["header"],
): string {
  return JSON.stringify(
    header && {
      v: header.v,
      createdAt: header.createdAt,
      kdf: header.kdf,
      wrap: header.wrap,
      unlocks: header.unlocks,
    },
  );
}
function publicTarget(connectionId: string, protocol: NativeIdentityProtocol) {
  const provider = signInMethods().providers.find(
    (entry) => entry.connectionId === connectionId,
  );
  if (!provider || provider.protocol !== protocol)
    throw new Error(
      "This native identity connection is not enabled for sign-in",
    );
  return {
    bytes: JSON.stringify(provider),
    issuer: provider.issuer,
    audience: provider.clientId,
  };
}
class OriginalNativeIdentityOwner {
  readonly stop = new AbortController();
  readonly authGeneration = currentAuthGeneration();
  readonly identitySession = currentSession();
  readonly identityRealm = resolveIdentityBase();
  readonly original = vaultStore.getSnapshot();
  readonly originalHeader = JSON.stringify(this.original.header);
  readonly target: ReturnType<typeof publicTarget>;
  readonly subscriptions: (() => void)[] = [];
  readonly originalRevision: string | null;
  generation = federationSessionGeneration();
  material = credentialMaterial(this.original.header);
  configuration: Readonly<{
    bytes: string;
    revision: string;
    issuer: string;
    audience: string;
  }> | null = null;
  installed = false;
  released = false;
  constructor(
    readonly connectionId: string,
    readonly protocol: NativeIdentityProtocol,
    readonly resolveTarget: NativeIdentityTargetResolver,
  ) {
    this.originalRevision = identityConnectionRevision(connectionId);
    this.target = publicTarget(connectionId, protocol);
    this.subscriptions.push(
      vaultStore.onLock(this.release),
      subscribeDeviceRows(this.observe),
      subscribeSettings(this.observe),
      subscribeIdentitySession(this.observe),
    );
  }
  release = (): void => {
    if (this.released) return;
    this.released = true;
    this.stop.abort();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  };
  observe = (): void => {
    try {
      this.assertLocal();
      this.assertConfiguration();
    } catch {
      this.release();
    }
  };
  assertLocal(): void {
    this.stop.signal.throwIfAborted();
    if (
      currentAuthGeneration() !== this.authGeneration ||
      currentSession() !== this.identitySession ||
      resolveIdentityBase() !== this.identityRealm ||
      publicTarget(this.connectionId, this.protocol).bytes !==
        this.target.bytes ||
      vaultStore.getSnapshot().tomb !== this.original.tomb
    )
      throw new Error(
        "Original identity user, vault or configured target changed",
      );
  }
  assertConfiguration(): void {
    const saved = this.configuration;
    if (!saved) {
      if (
        this.originalRevision !== null &&
        identityConnectionRevision(this.connectionId) !== this.originalRevision
      )
        throw new Error(
          "Saved identity configuration changed before hydration",
        );
      return;
    }
    if (
      identityConnectionRevision(this.connectionId) !== saved.revision ||
      JSON.stringify(getIdentityConnectionRuntime(this.connectionId)) !==
        saved.bytes
    )
      throw new Error("Saved identity configuration changed during sign-in");
  }
  assertPending = (): void => {
    this.assertLocal();
    this.assertConfiguration();
    const now = vaultStore.getSnapshot();
    if (
      this.generation !== federationSessionGeneration() ||
      now.status !== this.original.status ||
      now.guest !== this.original.guest ||
      now.awaitingSecondStep !== this.original.awaitingSecondStep ||
      JSON.stringify(now.header) !== this.originalHeader
    )
      throw new Error("Original pending identity ceremony changed");
  };
  bindConfiguration = (draft: IdentityConnectionDraft): void => {
    this.assertPending();
    if (this.configuration || draft.protocol !== this.protocol)
      throw new Error(
        "Capture the original native identity configuration once",
      );
    const revision = identityConnectionRevision(this.connectionId);
    if (
      !revision ||
      JSON.stringify(getIdentityConnectionRuntime(this.connectionId)) !==
        JSON.stringify(draft)
    )
      throw new Error("Saved identity configuration is unavailable or changed");
    const target = this.resolveTarget(draft);
    if (
      this.target.issuer !== target.issuer ||
      this.target.audience !== target.audience
    )
      throw new Error(
        "Configured native identity trust does not match the saved adapter",
      );
    this.configuration = Object.freeze({
      bytes: JSON.stringify(draft),
      revision,
      issuer: target.issuer,
      audience: target.audience,
    });
  };
  prepareRuntime = (install: () => void): void => {
    this.assertPending();
    if (this.installed)
      throw new Error("Native identity runtime was already prepared");
    this.installed = true;
    install();
    this.assertLocal();
    this.assertConfiguration();
    this.generation = federationSessionGeneration();
    this.assertPending();
  };
  assertSessionCurrent = (issuer: string, audience: string): void => {
    this.assertLocal();
    this.assertConfiguration();
    const saved = this.configuration;
    const now = vaultStore.getSnapshot();
    if (!saved || issuer !== saved.issuer || audience !== saved.audience)
      throw new Error(
        "Verified native identity does not match its saved issuer and audience",
      );
    // This comparison grants no vault permission. The ordinary vault command still proves its own key.
    // An originally empty tomb may be sealed by its normal setup ceremony after identity admission.
    if (
      this.original.header === null &&
      this.material === "null" &&
      now.header !== null &&
      !now.guest
    )
      this.material = credentialMaterial(now.header);
    if (
      credentialMaterial(now.header) !== this.material ||
      now.guest !== this.original.guest
    )
      throw new Error("Original vault credential lineage changed");
  };
}
/** Capture before the first ledger/network/import await; this does not manufacture protocol evidence. */
export function captureNativeIdentityOwner(
  connectionId: string,
  protocol: NativeIdentityProtocol = "saml",
  resolveTarget?: NativeIdentityTargetResolver,
): NativeIdentityOwner {
  if (protocol === "ldap" && !resolveTarget)
    throw new Error("LDAP requires its exact configured realm and audience");
  const original = new OriginalNativeIdentityOwner(
    connectionId,
    protocol,
    resolveTarget ??
      ((draft) => ({
        issuer: protocol === "saml" ? draft.samlEntityId : draft.issuer,
        audience: draft.clientId,
      })),
  );
  return Object.freeze({
    signal: original.stop.signal,
    assertPending: original.assertPending,
    bindConfiguration: original.bindConfiguration,
    prepareRuntime: original.prepareRuntime,
    assertSessionCurrent: original.assertSessionCurrent,
    release: original.release,
  });
}
