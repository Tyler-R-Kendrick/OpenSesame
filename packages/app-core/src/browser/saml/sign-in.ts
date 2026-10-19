/** Native browser SAML: original popup/request, controlled POST custody, actual signature, and one-use claims. */
import type { NativeOAuthDeviceConsent } from "../../lib/native-oauth-browser-port.js";
import {
  type NativeAuthPopup,
  reserveNativeAuthPopup,
} from "../native-auth-session.js";
import type {
  SamlPendingRequest,
  SamlTimePolicy,
} from "./assertion-conditions.js";
import { claimNativeSamlAssertion } from "./assertion-replay.js";
import { type SamlProtocolClaims, validateSamlAssertion } from "./assertion.js";
import { createSamlAuthnPost } from "./authn-request.js";
import type { SamlRequestSigning } from "./authn-signature.js";
import { type SamlIdpMetadata, readSamlIdpMetadata } from "./metadata.js";
import {
  type SamlPostReceiver,
  prepareSamlPostReceiver,
} from "./post-session.js";
import {
  type SamlPostOwner,
  assertSamlPostOwner,
  samlPostBytes,
  samlPostLocation,
} from "./post-wire.js";
import { verifySamlXmlSignature } from "./xml-signature.js";

export type NativeSamlSignInOptions = Readonly<{
  scopeUrl: string;
  issuer: string;
  audience: string;
  metadataXml: string;
  loadMetadataXml?: () => Promise<string>;
  reservedPopup?: Pick<NativeAuthPopup, "showFormConsent" | "cancel">;
  nameIdFormat: string;
  authnContext: string;
  forceAuthentication: boolean;
  timePolicy: SamlTimePolicy;
  signing?: SamlRequestSigning;
  owner: SamlPostOwner;
}>;
const brand: unique symbol = Symbol("native-saml-sign-in");
export type NativeSamlSignInProof = Readonly<{ [brand]: true }>;
export type NativeSamlVerifiedIdentity = Readonly<{
  claims: SamlProtocolClaims;
  assertCurrent: () => void;
  release: () => void;
}>;
export type NativeSamlSignIn = Readonly<{
  result: Promise<NativeSamlSignInProof>;
  cancel: () => void;
}>;
const proofs = new WeakMap<NativeSamlSignInProof, NativeSamlVerifiedIdentity>();
function endpointBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
class NativeSamlAttempt {
  readonly stop = new AbortController();
  readonly owner: SamlPostOwner;
  readonly pending: SamlPendingRequest;
  readonly acsUrl: string;
  readonly popup: Pick<NativeAuthPopup, "showFormConsent" | "cancel">;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly result: Promise<NativeSamlSignInProof>;
  receiver: SamlPostReceiver | null = null;
  consent: NativeOAuthDeviceConsent | null = null;
  consumed = false;
  released = false;
  proof: NativeSamlSignInProof | null = null;
  constructor(readonly options: NativeSamlSignInOptions) {
    assertSamlPostOwner(options.owner);
    this.acsUrl = new URL("auth/native-saml", options.scopeUrl).href;
    samlPostLocation(options.scopeUrl, this.acsUrl);
    const now = Date.now();
    this.pending = Object.freeze({
      requestId: `_${samlPostBytes(crypto.getRandomValues(new Uint8Array(32)).buffer)}`,
      issuer: options.issuer,
      audience: options.audience,
      acsUrl: this.acsUrl,
      issuedAt: now,
      expiresAt: now + 300000,
      nameIdFormat: options.nameIdFormat,
      authnContext: options.authnContext,
      forceAuthentication: options.forceAuthentication,
    });
    this.owner = Object.freeze({
      signal: AbortSignal.any([this.stop.signal, options.owner.signal]),
      assertCurrent: () => {
        options.owner.assertCurrent();
        if (this.released || this.pending.expiresAt <= Date.now())
          throw new Error("SAML originating request expired or was cancelled");
      },
    });
    // The saved-config facade can reserve before ledger hydration and this lazy protocol import.
    this.popup = options.reservedPopup ?? reserveNativeAuthPopup();
    this.timer = setTimeout(
      this.cancel,
      Math.max(0, this.pending.expiresAt - now),
    );
    this.owner.signal.addEventListener("abort", this.cancel, { once: true });
    window.addEventListener("pagehide", this.cancel, { once: true });
    this.result = this.run();
    void this.result.catch(() => undefined);
  }
  current = (): void => assertSamlPostOwner(this.owner);
  release = (): void => {
    if (this.released) return;
    this.released = true;
    if (this.proof) proofs.delete(this.proof);
    clearTimeout(this.timer);
    this.owner.signal.removeEventListener("abort", this.cancel);
    window.removeEventListener("pagehide", this.cancel);
    this.receiver?.close();
    this.receiver = null;
    this.closeConsent();
    this.popup.cancel();
    this.stop.abort();
  };
  cancel = (): void => this.release();
  closeConsent(): void {
    this.consent?.signal.removeEventListener("abort", this.cancel);
    this.consent?.close();
    this.consent = null;
  }
  async prepare(metadata: SamlIdpMetadata): Promise<void> {
    this.current();
    this.receiver = await prepareSamlPostReceiver({
      scopeUrl: this.options.scopeUrl,
      acsUrl: this.acsUrl,
      requestId: this.pending.requestId,
      expiresAt: this.pending.expiresAt,
      idpOrigin: new URL(metadata.postUrl).origin,
      owner: this.owner,
    });
    this.current();
    const post = await createSamlAuthnPost(
      this.pending,
      metadata,
      this.owner,
      this.options.signing,
    );
    this.current();
    this.consent = this.popup.showFormConsent({
      authorizationUrl: post.destination,
      state: this.receiver.nonce,
      expiresAt: this.pending.expiresAt,
      signal: this.owner.signal,
      fields: { SAMLRequest: post.request, RelayState: this.receiver.nonce },
    });
    this.consent.signal.addEventListener("abort", this.cancel, { once: true });
    // Do not use WindowProxy.closed after navigation: real COOP can sever it while consent remains live.
  }
  async verify(metadata: SamlIdpMetadata): Promise<SamlProtocolClaims> {
    const receiver = this.receiver;
    if (!receiver) throw new Error("SAML POST receiver was not prepared");
    const returned = await receiver.result;
    this.current();
    if (
      this.consumed ||
      returned.nonce !== receiver.nonce ||
      returned.requestId !== this.pending.requestId ||
      returned.acsUrl !== this.acsUrl
    )
      throw new Error("SAML return did not match the original request");
    this.consumed = true; // Original pending request is one-use before the first signature await.
    const proof = await verifySamlXmlSignature(
      returned.response,
      metadata.signingSpki.map(endpointBytes),
      this.owner,
    );
    this.current();
    if (metadata.expiresAt !== null && metadata.expiresAt <= Date.now())
      throw new Error("Configured SAML metadata expired during sign-in");
    const claims = validateSamlAssertion(
      proof,
      this.pending,
      this.options.timePolicy,
      Date.now(),
    );
    claimNativeSamlAssertion(claims, Date.now());
    this.current();
    return claims;
  }
  async run(): Promise<NativeSamlSignInProof> {
    try {
      this.current();
      if (
        Boolean(this.options.metadataXml) ===
        Boolean(this.options.loadMetadataXml)
      )
        throw new Error("Choose exactly one configured SAML metadata source");
      const metadataXml = this.options.loadMetadataXml
        ? await this.options.loadMetadataXml()
        : this.options.metadataXml;
      this.current();
      const metadata = await readSamlIdpMetadata(
        metadataXml,
        this.options.issuer,
        this.owner,
      );
      this.current();
      await this.prepare(metadata);
      const claims = await this.verify(metadata);
      this.current();
      const proof: NativeSamlSignInProof = Object.freeze({ [brand]: true });
      this.proof = proof;
      proofs.set(
        proof,
        Object.freeze({
          claims,
          assertCurrent: () => {
            this.current();
            if (claims.validUntil <= Date.now())
              throw new Error("SAML identity expired before admission");
          },
          release: this.release,
        }),
      );
      this.receiver?.close();
      this.receiver = null;
      this.closeConsent();
      return proof;
    } catch (error) {
      this.release();
      throw error;
    }
  }
}
function captureOwner(original: SamlPostOwner): SamlPostOwner {
  const signal = original.signal;
  const assertCurrent = original.assertCurrent;
  const unchanged = () => {
    signal.throwIfAborted();
    if (original.signal !== signal || original.assertCurrent !== assertCurrent)
      throw new Error("Original SAML owner changed");
  };
  return Object.freeze({
    signal,
    assertCurrent() {
      unchanged();
      assertCurrent.call(original);
      unchanged();
    },
  });
}
function capturePopup(original: NativeSamlSignInOptions["reservedPopup"]) {
  if (!original) return undefined;
  const show = original.showFormConsent;
  const cancel = original.cancel;
  return Object.freeze({
    showFormConsent(
      request: Parameters<NativeAuthPopup["showFormConsent"]>[0],
    ) {
      if (original.showFormConsent !== show || original.cancel !== cancel)
        throw new Error("Original SAML popup changed");
      return show.call(original, request);
    },
    cancel: () => cancel.call(original),
  });
}
/** The browser shell supplies a guard for the exact saved connection and initiating user/vault lineage. */
export function beginNativeSamlSignIn(
  options: NativeSamlSignInOptions,
): NativeSamlSignIn {
  const captured = Object.freeze({
    ...options,
    reservedPopup: capturePopup(options.reservedPopup),
    timePolicy: Object.freeze({ ...options.timePolicy }),
    signing: options.signing
      ? Object.freeze({ ...options.signing })
      : undefined,
    owner: captureOwner(options.owner),
  });
  try {
    const attempt = new NativeSamlAttempt(captured);
    return Object.freeze({ result: attempt.result, cancel: attempt.cancel });
  } catch (error) {
    captured.reservedPopup?.cancel();
    throw error;
  }
}
/** Consume only genuine completed signature/protocol proof once; JSON and copied fields cannot admit. */
export function consumeNativeSamlSignIn(
  proof: NativeSamlSignInProof,
): NativeSamlVerifiedIdentity {
  const verified = proofs.get(proof);
  if (!verified)
    throw new Error(
      "Native SAML sign-in proof is unavailable or already consumed",
    );
  proofs.delete(proof);
  try {
    verified.assertCurrent();
    return verified;
  } catch (error) {
    verified.release();
    throw error;
  }
}
