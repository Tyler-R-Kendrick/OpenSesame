/**
 * Channel binding for a live session: both device keys sign the handshake,
 * and the SAS is derived from both keys, both DTLS fingerprints, and a
 * session nonce. A different session, or a substituted key, is a different SAS.
 */
import { toB64url } from "../live/b64.js";
import { sasFromFingerprint } from "./sas.js";
import { sha256Hex, signP256, verifyP256 } from "./webcrypto.js";

const encoder = new TextEncoder();

export const ABSENT_DTLS = "absent";
/** Owner half of an unsigned manual-code join. Not a real device key. */
export const UNVERIFIED_OWNER_KEY = "0".repeat(64);

const FINGERPRINT = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const DTLS = /^(?:absent|sha-256 [0-9a-f]{2}(?::[0-9a-f]{2}){31})$/;
const SPKI = /^[A-Za-z0-9+/]{80,200}={0,2}$/;
const SIG = /^[A-Za-z0-9+/]{40,200}={0,2}$/;

export type SessionBinding = Readonly<{
  ownerKey: string;
  joinerKey: string;
  ownerDtls: string;
  joinerDtls: string;
  ownerNonce: string;
  joinerNonce: string;
}>;

export type OwnerIntroFields = Readonly<{
  enrollmentEpoch: number;
  ownerDtls: string;
  ownerKey: string;
  ownerNonce: string;
}>;

export type OwnerIntro = Readonly<{
  ownerNonce: string;
  ownerDtls: string;
  introSignatureB64: string;
}>;

export function isFingerprint(value: string): boolean {
  return FINGERPRINT.test(value);
}

export function isNonce(value: string): boolean {
  return NONCE.test(value);
}

export function isDtlsFingerprint(value: string): boolean {
  return DTLS.test(value);
}

export function isSpkiB64(value: string): boolean {
  return SPKI.test(value);
}

export function isSigB64(value: string): boolean {
  return SIG.test(value);
}

export function randomNonce(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function bindingValid(binding: SessionBinding): boolean {
  return (
    isFingerprint(binding.ownerKey) &&
    isFingerprint(binding.joinerKey) &&
    isDtlsFingerprint(binding.ownerDtls) &&
    isDtlsFingerprint(binding.joinerDtls) &&
    isNonce(binding.ownerNonce) &&
    isNonce(binding.joinerNonce)
  );
}

/** `sha-256` fingerprint from an SDP line, or `absent` when the offer has none. */
export function dtlsFingerprintFromSdp(sdp: string): string {
  const match = /a=fingerprint:([^\r\n]+)/i.exec(sdp);
  if (!match?.[1]) return ABSENT_DTLS;
  return normalizeDtlsFingerprint(match[1].trim());
}

export function normalizeDtlsFingerprint(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 2) return ABSENT_DTLS;
  const algo = parts[0]?.toLowerCase();
  const hex = parts[1]?.toLowerCase();
  if (algo !== "sha-256" || !hex) return ABSENT_DTLS;
  const body = hex.replace(/:/g, "");
  if (!/^[0-9a-f]{64}$/.test(body)) return ABSENT_DTLS;
  const grouped = body.match(/.{2}/g)?.join(":");
  if (!grouped) return ABSENT_DTLS;
  const value = `sha-256 ${grouped}`;
  return isDtlsFingerprint(value) ? value : ABSENT_DTLS;
}

export function answerAgrees(ownerDtls: string, answerSdp: string): boolean {
  if (ownerDtls === ABSENT_DTLS || answerSdp.length === 0) return true;
  return dtlsFingerprintFromSdp(answerSdp) === ownerDtls;
}

export async function sasFromBinding(
  binding: SessionBinding,
): Promise<string | null> {
  if (!bindingValid(binding)) return null;
  const sessionNonce = await sha256Hex(
    encoder.encode(`${binding.ownerNonce}.${binding.joinerNonce}`),
  );
  const digest = await sha256Hex(
    encoder.encode(
      JSON.stringify({
        joinerDtls: binding.joinerDtls,
        joinerKey: binding.joinerKey,
        ownerDtls: binding.ownerDtls,
        ownerKey: binding.ownerKey,
        sessionNonce,
      }),
    ),
  );
  return sasFromFingerprint(digest);
}

export async function signBinding(
  privateKey: CryptoKey,
  binding: SessionBinding,
): Promise<string | null> {
  if (!bindingValid(binding)) return null;
  return signP256(privateKey, encoder.encode(bindingJson(binding)));
}

export async function verifyBinding(
  spkiB64: string,
  signatureB64: string,
  binding: SessionBinding,
): Promise<boolean> {
  if (
    !bindingValid(binding) ||
    !isSpkiB64(spkiB64) ||
    !isSigB64(signatureB64)
  ) {
    return false;
  }
  return verifyP256(
    spkiB64,
    signatureB64,
    encoder.encode(bindingJson(binding)),
  );
}

export function introValid(fields: OwnerIntroFields): boolean {
  return (
    Number.isInteger(fields.enrollmentEpoch) &&
    fields.enrollmentEpoch >= 1 &&
    isDtlsFingerprint(fields.ownerDtls) &&
    isFingerprint(fields.ownerKey) &&
    isNonce(fields.ownerNonce)
  );
}

export async function signOwnerIntro(
  privateKey: CryptoKey,
  fields: OwnerIntroFields,
): Promise<OwnerIntro | null> {
  if (!introValid(fields)) return null;
  const introSignatureB64 = await signP256(
    privateKey,
    encoder.encode(introJson(fields)),
  );
  if (!introSignatureB64 || !isSigB64(introSignatureB64)) return null;
  return {
    ownerNonce: fields.ownerNonce,
    ownerDtls: fields.ownerDtls,
    introSignatureB64,
  };
}

export async function verifyOwnerIntro(
  spkiB64: string,
  fields: OwnerIntroFields,
  signatureB64: string,
): Promise<boolean> {
  if (!introValid(fields) || !isSpkiB64(spkiB64) || !isSigB64(signatureB64)) {
    return false;
  }
  return verifyP256(spkiB64, signatureB64, encoder.encode(introJson(fields)));
}

export async function sha256HexOf(text: string): Promise<string> {
  return sha256Hex(encoder.encode(text));
}

function bindingJson(binding: SessionBinding): string {
  return JSON.stringify({
    joinerDtls: binding.joinerDtls,
    joinerKey: binding.joinerKey,
    joinerNonce: binding.joinerNonce,
    ownerDtls: binding.ownerDtls,
    ownerKey: binding.ownerKey,
    ownerNonce: binding.ownerNonce,
  });
}

function introJson(fields: OwnerIntroFields): string {
  return JSON.stringify({
    enrollmentEpoch: fields.enrollmentEpoch,
    ownerDtls: fields.ownerDtls,
    ownerKey: fields.ownerKey,
    ownerNonce: fields.ownerNonce,
  });
}
