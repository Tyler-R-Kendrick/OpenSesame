/** Shared local admission lifecycle; trusted protocol adapters consume genuine one-use evidence. */
import {
  type FederationSessionGeneration,
  type NativeFederationIdentity,
  advanceFederationSessionGeneration,
  bindNativeFederationSession,
  federationSessionGeneration,
} from "./federation-native-session.js";
import { notifyFederationSessionChanged } from "./federation-session-events.js";
import { clearFederationSessionJson } from "./federation-session-store.js";
import { openVaultAfterSignIn } from "./guest-auth.js";
import { vaultStore } from "./vault/store.js";
export type NativeIdentityClaims = Readonly<{
  issuer: string;
  audience: string;
  validUntil: number;
}>;
export type NativeIdentityAdmissionTarget<C extends NativeIdentityClaims> =
  Readonly<{
    connectionId: string;
    label: string;
    /** Rechecks exact saved configuration, configured trust, auth generation and original user/vault lineage. */
    assertSessionCurrent: (claims: C) => void;
    retireProtocol?: () => Promise<void>;
    releaseSession?: () => void;
  }>;
export type NativeIdentityAdmissionRuntime<
  P,
  C extends NativeIdentityClaims,
> = Readonly<{
  admit: (
    proof: P,
    target: NativeIdentityAdmissionTarget<C>,
  ) => Promise<NativeFederationIdentity>;
  clear: () => void;
  dispose: () => void;
}>;
type ProtocolAdapter<P, C extends NativeIdentityClaims> = Readonly<{
  consume: (proof: P) => Readonly<{
    claims: C;
    assertCurrent: () => void;
    release: () => void;
  }>;
  project: (
    claims: C,
    target: NativeIdentityAdmissionTarget<C>,
  ) => Promise<NativeFederationIdentity>;
}>;
type Session = Readonly<{
  identity: NativeFederationIdentity;
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
  release: () => void;
}>;
let activeLease: object | null = null;
function assertTarget<C extends NativeIdentityClaims>(
  target: NativeIdentityAdmissionTarget<C>,
  claims: C,
): void {
  if (
    !target.connectionId ||
    target.connectionId.length > 128 ||
    target.connectionId.trim() !== target.connectionId ||
    !target.label.trim() ||
    target.label.length > 128
  )
    throw new Error("Native identity admission requires its saved connection");
  if (
    !Number.isSafeInteger(claims.validUntil) ||
    claims.validUntil <= Date.now()
  )
    throw new Error("Verified native identity expired before local admission");
  target.assertSessionCurrent(claims);
}
function captureTarget<C extends NativeIdentityClaims>(
  input: NativeIdentityAdmissionTarget<C>,
): NativeIdentityAdmissionTarget<C> {
  const {
    connectionId,
    label,
    assertSessionCurrent,
    retireProtocol,
    releaseSession,
  } = input;
  return Object.freeze({
    connectionId,
    label,
    assertSessionCurrent(claims: C) {
      if (
        input.connectionId !== connectionId ||
        input.label !== label ||
        input.assertSessionCurrent !== assertSessionCurrent ||
        input.retireProtocol !== retireProtocol
      )
        throw new Error("Original native identity admission target changed");
      assertSessionCurrent.call(input, claims);
      if (
        input.connectionId !== connectionId ||
        input.label !== label ||
        input.assertSessionCurrent !== assertSessionCurrent ||
        input.retireProtocol !== retireProtocol
      )
        throw new Error("Original native identity admission target changed");
    },
    retireProtocol: retireProtocol
      ? () => retireProtocol.call(input)
      : undefined,
    releaseSession: releaseSession
      ? () => releaseSession.call(input)
      : undefined,
  });
}
class NativeAdmission<P, C extends NativeIdentityClaims> {
  readonly lease = Object.freeze({});
  readonly unbind: () => void;
  disposed = false;
  current: Session | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly adapter: ProtocolAdapter<P, C>) {
    activeLease = this.lease;
    this.unbind = bindNativeFederationSession({
      clear: this.clearLocal,
      read: this.read,
    });
  }
  clearLocal = (): void => {
    const previous = this.current;
    this.current = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (previous) notifyFederationSessionChanged();
    previous?.release();
  };
  assertRuntime = (): void => {
    if (this.disposed || activeLease !== this.lease)
      throw new Error("Native identity runtime was replaced or disabled");
  };
  read = (): NativeFederationIdentity | null => {
    this.assertRuntime();
    const selected = this.current;
    if (!selected) return null;
    if (selected.generation !== federationSessionGeneration()) {
      this.clearLocal();
      return null;
    }
    selected.assertCurrent();
    return selected.identity;
  };
  publish(
    identity: NativeFederationIdentity,
    target: NativeIdentityAdmissionTarget<C>,
    claims: C,
  ): void {
    const published = advanceFederationSessionGeneration();
    const assertPublished = () => {
      this.assertRuntime();
      if (federationSessionGeneration() !== published)
        throw new Error("Native identity publication was superseded");
    };
    assertPublished();
    clearFederationSessionJson();
    assertPublished();
    assertTarget(target, claims);
    assertPublished();
    this.current = Object.freeze({
      identity,
      generation: published,
      assertCurrent: () => {
        this.assertRuntime();
        assertTarget(target, claims);
      },
      release: () => target.releaseSession?.(),
    });
    this.timer = setTimeout(
      () => {
        if (this.current?.identity === identity)
          advanceFederationSessionGeneration();
      },
      Math.max(0, identity.expiresAt - Date.now()),
    );
    notifyFederationSessionChanged();
  }
  admit = async (
    proof: P,
    input: NativeIdentityAdmissionTarget<C>,
  ): Promise<NativeFederationIdentity> => {
    this.assertRuntime();
    const target = captureTarget(input);
    const verified = this.adapter.consume(proof);
    const claims = verified.claims;
    const original = () => {
      this.assertRuntime();
      verified.assertCurrent();
      assertTarget(target, claims);
      this.assertRuntime();
    };
    const local = () => {
      this.assertRuntime();
      assertTarget(target, claims);
      this.assertRuntime();
    };
    let released = false;
    const releaseProtocol = () => {
      if (released) return;
      released = true;
      verified.release();
    };
    try {
      original();
      const identity = await this.adapter.project(claims, target);
      original();
      // A consumed genuine proof is projected and rechecked before its carrier retires.
      releaseProtocol();
      await target.retireProtocol?.();
      local();
      // This requests only the existing local unlock ceremony; identity never decrypts or creates a vault.
      if (vaultStore.getSnapshot().status !== "empty")
        await openVaultAfterSignIn();
      local();
      this.publish(identity, target, claims);
      return identity;
    } finally {
      releaseProtocol();
    }
  };
  clear = (): void => {
    this.assertRuntime();
    advanceFederationSessionGeneration();
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    if (activeLease === this.lease) activeLease = null;
    this.clearLocal();
    this.unbind();
  };
}
/** Protocol-specific adapters own proof verification; scalar form data is never an admission proof. */
export function createNativeIdentityAdmissionRuntime<
  P,
  C extends NativeIdentityClaims,
>(adapter: ProtocolAdapter<P, C>): NativeIdentityAdmissionRuntime<P, C> {
  const runtime = new NativeAdmission(adapter);
  return Object.freeze({
    admit: runtime.admit,
    clear: runtime.clear,
    dispose: runtime.dispose,
  });
}
