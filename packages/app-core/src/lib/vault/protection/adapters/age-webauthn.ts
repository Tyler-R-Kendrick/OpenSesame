/**
 * Age WebAuthn root protector (typage `age.webauthn`, distinct from OS PRF).
 *
 * Encrypts the structured root capsule with WebAuthnRecipient / Identity.
 * Verified enrollment requires an open proof with the same credential.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import * as age from "age-encryption";
import { canonicalizeToBytes } from "../canonicalize.js";
import { contextsEqual } from "../capsule.js";
import { ProtectionError } from "../errors.js";
import { newProtectorId } from "../ids.js";
import { DOMAIN_CAPSULE, ROOT_KEY_BYTES } from "../limits.js";
import type {
  AgeWebauthnProtectorRecord,
  ProtectionContext,
  VerificationEvidence,
} from "../types.js";

export type AgeWebauthnCrypto = {
  createCredential(input: {
    keyName: string;
    rpId?: string;
    type?: "passkey" | "security-key";
  }): Promise<string>;
  encrypt(plaintext: Uint8Array, identity: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, identity: string): Promise<Uint8Array>;
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function buildPayload(
  context: ProtectionContext,
  rootKey: Uint8Array,
): Uint8Array {
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return canonicalizeToBytes({
    v: 1,
    domain: DOMAIN_CAPSULE,
    context,
    rootKeyB64: bytesToB64(rootKey),
  });
}

function parsePurpose(value: string): ProtectionContext["purpose"] {
  if (value === "human-vault-root" || value === "workload-root") return value;
  throw new ProtectionError(
    "context_mismatch",
    "Age WebAuthn capsule purpose is invalid.",
  );
}

function parsePayload(
  plaintext: Uint8Array,
  expected: ProtectionContext,
): Uint8Array {
  const decoded: BoundaryValue = JSON.parse(
    new TextDecoder().decode(plaintext),
  );
  if (
    !isJsonObject(decoded) ||
    decoded.v !== 1 ||
    decoded.domain !== DOMAIN_CAPSULE
  ) {
    throw new ProtectionError(
      "malformed_encoding",
      "Age WebAuthn capsule plaintext is malformed.",
    );
  }
  if (!isString(decoded.rootKeyB64) || !isJsonObject(decoded.context)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Age WebAuthn capsule fields are malformed.",
    );
  }
  const ctx = decoded.context;
  if (
    !isString(ctx.vaultId) ||
    !isString(ctx.rootKeyId) ||
    !isNumber(ctx.rootEpoch) ||
    !isString(ctx.protectorId) ||
    !isString(ctx.purpose)
  ) {
    throw new ProtectionError(
      "context_mismatch",
      "Age WebAuthn capsule context fields are invalid.",
    );
  }
  const parsedContext: ProtectionContext = {
    vaultId: ctx.vaultId,
    rootKeyId: ctx.rootKeyId,
    rootEpoch: ctx.rootEpoch,
    protectorId: ctx.protectorId,
    purpose: parsePurpose(ctx.purpose),
  };
  if (!contextsEqual(parsedContext, expected)) {
    throw new ProtectionError(
      "context_mismatch",
      "Age WebAuthn capsule context does not match.",
    );
  }
  const root = b64ToBytes(decoded.rootKeyB64);
  if (root.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Recovered root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return root;
}

export function defaultAgeWebauthnCrypto(): AgeWebauthnCrypto {
  return {
    async createCredential(input) {
      if (input.rpId && input.type) {
        return age.webauthn.createCredential({
          keyName: input.keyName,
          rpId: input.rpId,
          type: input.type,
        });
      }
      if (input.rpId) {
        return age.webauthn.createCredential({
          keyName: input.keyName,
          rpId: input.rpId,
        });
      }
      if (input.type) {
        return age.webauthn.createCredential({
          keyName: input.keyName,
          type: input.type,
        });
      }
      return age.webauthn.createCredential({ keyName: input.keyName });
    },
    async encrypt(plaintext, identity) {
      const encrypter = new age.Encrypter();
      encrypter.addRecipient(new age.webauthn.WebAuthnRecipient({ identity }));
      return new Uint8Array(await encrypter.encrypt(plaintext));
    },
    async decrypt(ciphertext, identity) {
      const decrypter = new age.Decrypter();
      decrypter.addIdentity(new age.webauthn.WebAuthnIdentity({ identity }));
      const out = await decrypter.decrypt(ciphertext, "uint8array");
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    },
  };
}

function softwareEvidence(evidenceRef: string): VerificationEvidence {
  return {
    kind: "software-roundtrip",
    implementationVersion: "age-encryption@0.3.1",
    testedAt: new Date().toISOString(),
    evidenceRef,
  };
}

export type EnrolledAgeWebauthn = {
  record: AgeWebauthnProtectorRecord;
  identity: string;
};

export type AgeWebauthnCreateInput = {
  keyName: string;
  rpId?: string;
  type?: "passkey" | "security-key";
};

export async function enrollAgeWebauthn(input: {
  context: ProtectionContext;
  rootKey: Uint8Array;
  keyName?: string;
  rpId?: string;
  crypto?: AgeWebauthnCrypto;
}): Promise<EnrolledAgeWebauthn> {
  const cryptoApi = input.crypto ?? defaultAgeWebauthnCrypto();
  const protectorId =
    input.context.protectorId.length > 0
      ? input.context.protectorId
      : newProtectorId("age-webauthn");
  const context: ProtectionContext = {
    ...input.context,
    protectorId,
  };
  const createInput: AgeWebauthnCreateInput = {
    keyName: input.keyName ?? "OpenSesame vault root",
  };
  if (input.rpId) {
    createInput.rpId = input.rpId;
  }
  const identity = await cryptoApi.createCredential(createInput);
  const capsule = await cryptoApi.encrypt(
    buildPayload(context, input.rootKey),
    identity,
  );
  const opened = parsePayload(
    await cryptoApi.decrypt(capsule, identity),
    context,
  );
  if (!equalBytes(opened, input.rootKey)) {
    throw new ProtectionError(
      "enrollment_proof_failed",
      "Age WebAuthn enrollment recovered a different root key.",
    );
  }
  opened.fill(0);
  const evidence = softwareEvidence(`age-webauthn-enroll:${protectorId}`);
  const record: AgeWebauthnProtectorRecord = {
    kind: "age-webauthn",
    protectorId,
    recipient: identity,
    capsuleAgeB64: bytesToB64(capsule),
    proofStatus: "verified",
    lastEvidence: evidence,
  };
  return { record, identity };
}

export async function openAgeWebauthn(input: {
  context: ProtectionContext;
  record: AgeWebauthnProtectorRecord;
  identity?: string;
  crypto?: AgeWebauthnCrypto;
}): Promise<Uint8Array> {
  const cryptoApi = input.crypto ?? defaultAgeWebauthnCrypto();
  const identity = input.identity ?? input.record.recipient;
  let plaintext: Uint8Array;
  try {
    plaintext = await cryptoApi.decrypt(
      b64ToBytes(input.record.capsuleAgeB64),
      identity,
    );
  } catch {
    throw new ProtectionError(
      "enrollment_proof_failed",
      "Age WebAuthn capsule could not be opened.",
    );
  }
  return parsePayload(plaintext, input.context);
}
