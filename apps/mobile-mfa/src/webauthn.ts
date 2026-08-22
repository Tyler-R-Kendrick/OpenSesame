import {
  type BoundaryValue,
  isBoolean,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
  isUndefined,
  overlapCast,
} from "@opensesame/os-domain";
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

function isOptionalNumber(value: BoundaryValue): value is number | undefined {
  return (
    isUndefined(value) ||
    (isNumber(value) && Number.isFinite(value) && value >= 0)
  );
}

const transports: readonly string[] = [
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "usb",
];
const userVerificationValues: readonly string[] = [
  "discouraged",
  "preferred",
  "required",
];

function isBase64url(value: BoundaryValue): value is string {
  return isString(value) && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isAuthenticatorSelection(value: BoundaryValue): boolean {
  if (!isJsonObject(value)) return false;
  return (
    (isUndefined(value.authenticatorAttachment) ||
      (isString(value.authenticatorAttachment) &&
        ["cross-platform", "platform"].includes(
          value.authenticatorAttachment,
        ))) &&
    (isUndefined(value.residentKey) ||
      (isString(value.residentKey) &&
        userVerificationValues.includes(value.residentKey))) &&
    (isUndefined(value.requireResidentKey) ||
      isBoolean(value.requireResidentKey)) &&
    (isUndefined(value.userVerification) ||
      (isString(value.userVerification) &&
        userVerificationValues.includes(value.userVerification)))
  );
}

function isCredentialDescriptorJson(value: BoundaryValue): value is {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
} {
  if (
    !isJsonObject(value) ||
    !isBase64url(value.id) ||
    value.type !== "public-key"
  ) {
    return false;
  }
  return (
    value.transports === undefined ||
    (Array.isArray(value.transports) &&
      value.transports.every(
        (transport) => isString(transport) && transports.includes(transport),
      ))
  );
}

export function parsePublicKeyCredentialCreationOptionsJson(
  value: BoundaryValue,
): PublicKeyCredentialCreationOptionsJSON | null {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.rp) ||
    !isJsonObject(value.user)
  ) {
    return null;
  }
  const valid =
    isString(value.rp.name) &&
    (isUndefined(value.rp.id) || isString(value.rp.id)) &&
    isBase64url(value.user.id) &&
    isString(value.user.name) &&
    isString(value.user.displayName) &&
    isBase64url(value.challenge) &&
    Array.isArray(value.pubKeyCredParams) &&
    value.pubKeyCredParams.length > 0 &&
    value.pubKeyCredParams.every(
      (parameter) =>
        isJsonObject(parameter) &&
        parameter.type === "public-key" &&
        isNumber(parameter.alg) &&
        Number.isInteger(parameter.alg),
    ) &&
    isOptionalNumber(value.timeout) &&
    (isUndefined(value.attestation) ||
      (isString(value.attestation) &&
        ["direct", "enterprise", "indirect", "none"].includes(
          value.attestation,
        ))) &&
    (isUndefined(value.authenticatorSelection) ||
      isAuthenticatorSelection(value.authenticatorSelection)) &&
    (value.excludeCredentials === undefined ||
      (Array.isArray(value.excludeCredentials) &&
        value.excludeCredentials.every(isCredentialDescriptorJson)));
  return valid ? overlapCast(value) : null;
}

export function parsePublicKeyCredentialRequestOptionsJson(
  value: BoundaryValue,
): PublicKeyCredentialRequestOptionsJSON | null {
  if (!isJsonObject(value) || !isBase64url(value.challenge)) return null;
  const valid =
    isOptionalNumber(value.timeout) &&
    (isUndefined(value.rpId) || isString(value.rpId)) &&
    (value.allowCredentials === undefined ||
      (Array.isArray(value.allowCredentials) &&
        value.allowCredentials.every(isCredentialDescriptorJson))) &&
    (value.userVerification === undefined ||
      (isString(value.userVerification) &&
        userVerificationValues.includes(value.userVerification)));
  return valid ? overlapCast(value) : null;
}

export function isPublicKeyCredential(
  value: Credential,
): value is PublicKeyCredential {
  const candidate: Partial<PublicKeyCredential> = overlapCast(value);
  return (
    value.type === "public-key" &&
    candidate.rawId instanceof ArrayBuffer &&
    candidate.response !== undefined &&
    isFunction(candidate.getClientExtensionResults)
  );
}

export function creationOptionsFromJson(
  json: PublicKeyCredentialCreationOptionsJSON,
): CredentialCreationOptions {
  return {
    publicKey: {
      ...json,
      challenge: b64urlToBytes(json.challenge),
      user: {
        ...json.user,
        id: b64urlToBytes(json.user.id),
      },
      excludeCredentials: json.excludeCredentials?.map((c) => ({
        ...c,
        id: b64urlToBytes(c.id),
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
      challenge: b64urlToBytes(json.challenge),
      allowCredentials: json.allowCredentials?.map((c) => ({
        ...c,
        id: b64urlToBytes(c.id),
      })),
    },
  };
}

export function registrationResponseJson(cred: PublicKeyCredential) {
  const response: Partial<AuthenticatorAttestationResponse> = overlapCast(
    cred.response,
  );
  if (
    !(response.clientDataJSON instanceof ArrayBuffer) ||
    !(response.attestationObject instanceof ArrayBuffer)
  ) {
    throw new TypeError(
      "WebAuthn registration response is not an attestation response",
    );
  }
  const getTransports = isFunction(response.getTransports)
    ? response.getTransports.bind(response)
    : undefined;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: "public-key" as const,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
      transports: getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

export function assertionPayload(cred: PublicKeyCredential) {
  const response: Partial<AuthenticatorAssertionResponse> = overlapCast(
    cred.response,
  );
  if (
    !(response.clientDataJSON instanceof ArrayBuffer) ||
    !(response.authenticatorData instanceof ArrayBuffer) ||
    !(response.signature instanceof ArrayBuffer)
  ) {
    throw new TypeError(
      "WebAuthn assertion response is not an authenticator assertion",
    );
  }
  return {
    credentialId: cred.id,
    clientDataJSON: bytesToB64url(response.clientDataJSON),
    authenticatorData: bytesToB64url(response.authenticatorData),
    signature: bytesToB64url(response.signature),
  };
}
