/** Native SAML account admission uses genuine one-use proof and the existing local vault outcome. */
import {
  type FederationSessionGeneration,
  type NativeFederationIdentity,
  advanceFederationSessionGeneration,
  bindNativeFederationSession,
  federationSessionGeneration,
} from "../../lib/federation-native-session.js";
import { clearFederationSessionJson } from "../../lib/federation-session-store.js";
import { openVaultAfterSignIn } from "../../lib/guest-auth.js";
import { vaultStore } from "../../lib/vault/store.js";
import type { SamlProtocolClaims } from "./assertion.js";
import {
  type NativeSamlSignInProof,
  consumeNativeSamlSignIn,
} from "./sign-in.js";

export type NativeSamlAdmissionTarget = Readonly<{
  connectionId: string;
  label: string;
  /** Rechecks exact saved configuration, configured trust, auth generation and original user/vault lineage. */
  assertSessionCurrent: (claims: SamlProtocolClaims) => void;
  retireProtocol?: () => Promise<void>;
  releaseSession?: () => void;
}>;
export type NativeSamlAdmissionRuntime = Readonly<{
  admit: (
    proof: NativeSamlSignInProof,
    target: NativeSamlAdmissionTarget,
  ) => Promise<NativeFederationIdentity>;
  clear: () => void;
  dispose: () => void;
}>;
type Session = Readonly<{
  identity: NativeFederationIdentity;
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
  release: () => void;
}>;
let activeLease: object | null = null;
async function subject(claims: SamlProtocolClaims): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify([
      "OpenSesame native SAML subject v1",
      location.origin,
      claims.issuer,
      claims.audience,
      claims.nameIdFormat,
      claims.nameQualifier,
      claims.spNameQualifier,
      claims.subject,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `saml:${btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
}
function assertTarget(
  target: NativeSamlAdmissionTarget,
  claims: SamlProtocolClaims,
): void {
  if (
    !target.connectionId ||
    target.connectionId.length > 128 ||
    target.connectionId.trim() !== target.connectionId ||
    !target.label.trim() ||
    target.label.length > 128
  )
    throw new Error("Native SAML admission requires its saved connection");
  if (
    !Number.isSafeInteger(claims.validUntil) ||
    claims.validUntil <= Date.now()
  )
    throw new Error("Verified native identity expired before local admission");
  target.assertSessionCurrent(claims);
}
function captureTarget(
  input: NativeSamlAdmissionTarget,
): NativeSamlAdmissionTarget {
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
    assertSessionCurrent(claims: SamlProtocolClaims) {
      if (
        input.connectionId !== connectionId ||
        input.label !== label ||
        input.assertSessionCurrent !== assertSessionCurrent ||
        input.retireProtocol !== retireProtocol
      )
        throw new Error("Original native SAML admission target changed");
      assertSessionCurrent.call(input, claims);
      if (
        input.connectionId !== connectionId ||
        input.label !== label ||
        input.assertSessionCurrent !== assertSessionCurrent ||
        input.retireProtocol !== retireProtocol
      )
        throw new Error("Original native SAML admission target changed");
    },
    retireProtocol: retireProtocol
      ? () => retireProtocol.call(input)
      : undefined,
    releaseSession: releaseSession
      ? () => releaseSession.call(input)
      : undefined,
  });
}
class SamlAdmission {
  readonly lease = Object.freeze({});
  readonly unbind: () => void;
  disposed = false;
  current: Session | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  constructor() {
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
    target: NativeSamlAdmissionTarget,
    claims: SamlProtocolClaims,
  ): void {
    advanceFederationSessionGeneration();
    clearFederationSessionJson();
    this.assertRuntime();
    assertTarget(target, claims);
    this.assertRuntime();
    this.current = Object.freeze({
      identity,
      generation: federationSessionGeneration(),
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
  }
  admit = async (
    proof: NativeSamlSignInProof,
    input: NativeSamlAdmissionTarget,
  ): Promise<NativeFederationIdentity> => {
    this.assertRuntime();
    const target = captureTarget(input);
    const verified = consumeNativeSamlSignIn(proof);
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
      const pairwiseSub = await subject(claims);
      original();
      const identity: NativeFederationIdentity = Object.freeze({
        assertionFormat: "saml",
        issuer: claims.issuer,
        audience: claims.audience,
        upstreamId: `identity:${target.connectionId}`,
        pairwiseSub,
        idToken: "",
        jwksUri: "",
        expiresAt: claims.validUntil,
        name: target.label,
      });
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
/** The capability installs one private native session owner; no caller can publish scalar SAML fields. */
export function createNativeSamlAdmissionRuntime(): NativeSamlAdmissionRuntime {
  const runtime = new SamlAdmission();
  return Object.freeze({
    admit: runtime.admit,
    clear: runtime.clear,
    dispose: runtime.dispose,
  });
}
