/**
 * The peer-trust block carried inside a live request or reply.
 * Readers check the spelling only; signatures are judged beside the SDP.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  isDtlsFingerprint,
  isFingerprint,
  isNonce,
  isSigB64,
  isSpkiB64,
} from "../peer-trust/handshake.js";

export type JoinPeerBlock = Readonly<{
  joinerKey: string;
  joinerSpkiB64: string;
  joinerNonce: string;
  joinerDtls: string;
  ownerKey: string;
  ownerNonce: string;
  ownerDtls: string;
  joinerSignatureB64: string;
  unverified: boolean;
  joinerEpoch?: number | undefined;
}>;

export type ReplyPeerBlock = Readonly<{
  sas: string;
  ownerSignatureB64: string;
  ownerSpkiB64: string;
}>;

const SAS = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/;

/** Undefined when the field is absent; null when it is present and unreadable. */
export function readJoinPeerBlock(
  value: BoundaryValue,
): JoinPeerBlock | null | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) return null;
  const block = readPeerFields(value);
  if (!block) return null;
  return block;
}

export function readReplyPeerBlock(
  value: BoundaryValue,
): ReplyPeerBlock | null | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) return null;
  const { sas, ownerSignatureB64, ownerSpkiB64 } = value;
  if (!isString(sas) || !SAS.test(sas)) return null;
  if (!isString(ownerSignatureB64) || !isSigB64(ownerSignatureB64)) return null;
  if (!isString(ownerSpkiB64) || !isSpkiB64(ownerSpkiB64)) return null;
  return { sas, ownerSignatureB64, ownerSpkiB64 };
}

function readPeerFields(value: {
  [key: string]: BoundaryValue;
}): JoinPeerBlock | null {
  const joinerKey = fingerprint(value.joinerKey);
  const joinerSpkiB64 = spki(value.joinerSpkiB64);
  const joinerNonce = nonce(value.joinerNonce);
  const joinerDtls = dtls(value.joinerDtls);
  const ownerKey = fingerprint(value.ownerKey);
  const ownerNonce = nonce(value.ownerNonce);
  const ownerDtls = dtls(value.ownerDtls);
  const joinerSignatureB64 = sig(value.joinerSignatureB64);
  const unverified = flag(value.unverified);
  const joinerEpoch = epoch(value.joinerEpoch);
  if (
    !joinerKey ||
    !joinerSpkiB64 ||
    !joinerNonce ||
    !joinerDtls ||
    !ownerKey ||
    !ownerNonce ||
    !ownerDtls ||
    !joinerSignatureB64 ||
    unverified === null ||
    joinerEpoch === null
  ) {
    return null;
  }
  const block: JoinPeerBlock = {
    joinerKey,
    joinerSpkiB64,
    joinerNonce,
    joinerDtls,
    ownerKey,
    ownerNonce,
    ownerDtls,
    joinerSignatureB64,
    unverified,
  };
  if (joinerEpoch === undefined) return block;
  return { ...block, joinerEpoch };
}

function fingerprint(value: BoundaryValue): string | null {
  return isString(value) && isFingerprint(value) ? value : null;
}

function nonce(value: BoundaryValue): string | null {
  return isString(value) && isNonce(value) ? value : null;
}

function dtls(value: BoundaryValue): string | null {
  return isString(value) && isDtlsFingerprint(value) ? value : null;
}

function spki(value: BoundaryValue): string | null {
  return isString(value) && isSpkiB64(value) ? value : null;
}

function sig(value: BoundaryValue): string | null {
  return isString(value) && isSigB64(value) ? value : null;
}

function flag(value: BoundaryValue): boolean | null {
  return value === true || value === false ? value : null;
}

/** Undefined when absent; null when present and not a positive integer. */
function epoch(value: BoundaryValue): number | null | undefined {
  if (value === undefined) return undefined;
  if (!isNumber(value) || !Number.isInteger(value) || value < 1) return null;
  return value;
}
