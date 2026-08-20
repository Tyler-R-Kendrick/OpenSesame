import { overlapCast } from "@opensesame/os-domain";
/** Minimal WebAuthn JSON ↔ ArrayBuffer helpers (no extra deps). */

export function b64urlToBytes(value: string): Uint8Array {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const b64 = (value + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export type PublicKeyCredentialCreationOptionsJSON = {
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: {
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }[];
};

export type PublicKeyCredentialRequestOptionsJSON = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: {
    id: string;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }[];
  userVerification?: UserVerificationRequirement;
};

export function creationOptionsFromJson(
  json: PublicKeyCredentialCreationOptionsJSON,
): CredentialCreationOptions {
  return {
    publicKey: {
      ...json,
      challenge: overlapCast(b64urlToBytes(json.challenge)),
      user: {
        ...json.user,
        id: overlapCast(b64urlToBytes(json.user.id)),
      },
      excludeCredentials: json.excludeCredentials?.map((c) => ({
        ...c,
        id: overlapCast(b64urlToBytes(c.id)),
      })),
    },
  };
}

export function requestOptionsFromJson(
  json: PublicKeyCredentialRequestOptionsJSON,
): CredentialRequestOptions {
  return {
    publicKey: {
      ...json,
      challenge: overlapCast(b64urlToBytes(json.challenge)),
      allowCredentials: json.allowCredentials?.map((c) => ({
        ...c,
        id: overlapCast(b64urlToBytes(c.id)),
      })),
    },
  };
}

export function registrationResponseJson(cred: PublicKeyCredential) {
  const response = overlapCast(cred.response);
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: "public-key" as const,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

export function assertionPayload(cred: PublicKeyCredential) {
  const response = overlapCast(cred.response);
  return {
    credentialId: cred.id,
    clientDataJSON: bytesToB64url(response.clientDataJSON),
    authenticatorData: bytesToB64url(response.authenticatorData),
    signature: bytesToB64url(response.signature),
  };
}
