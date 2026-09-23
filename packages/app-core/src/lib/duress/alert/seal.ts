/**
 * ALERT-A: Independently sealed activation/alert packages.
 * Never opens or requires the protected vault root (INV-04, INV-18).
 */

import {
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "../json-boundary.js";
import { b64ToBytes, bytesToB64, utf8 } from "./bytes.js";

const ALERT_PURPOSE = "opensesame/duress/alert-package/v1";
const EVIDENCE_PURPOSE = "opensesame/duress/alert-evidence/v1";

/** Value-blind template fields only — never vault item values (INV-18). */
export type AlertPayload = Readonly<Record<string, string>>;

export type SealedAlertPackage = Readonly<{
  schemaVersion: 1;
  packageId: string;
  incidentId: string;
  profileId: string;
  routeRef: string;
  templateRef: string;
  policyRevision: number;
  keyEpoch: number;
  /** Opaque ciphertext — no vault secrets in cleartext. */
  ciphertextB64: string;
  evidenceMacB64: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}>;

export type AlertSealingMaterial = Readonly<{
  encryptKey: CryptoKey;
  macKey: CryptoKey;
}>;

export type ProtectedRootAlertCandidate = Readonly<{
  kind?: string;
  opensProtectedRoot?: boolean;
}>;

/** Reject any attempt to treat vault-root handles as alert keys. */
export function rejectProtectedRootForAlert(
  candidate: ProtectedRootAlertCandidate,
): void {
  if (
    candidate.opensProtectedRoot === true ||
    candidate.kind === "protected_root"
  ) {
    throw new Error("unsupported_factor: alert must not open protected root");
  }
}

/**
 * Import independent alert sealing material from raw bytes.
 * Never derived from vault-root unwrap.
 */
export async function importAlertSealingKey(
  raw: Uint8Array,
): Promise<AlertSealingMaterial> {
  if (raw.byteLength < 32) {
    throw new Error("unsupported_factor: alert key material too short");
  }
  const encryptKey = await crypto.subtle.importKey(
    "raw",
    raw.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  // Domain-separate MAC key via a second import of the same entropy when only
  // 32 bytes are supplied — still not vault-root material.
  const macRaw =
    raw.byteLength >= 64
      ? raw.slice(32, 64)
      : await deriveMacRaw(raw.slice(0, 32));
  const macKey = await crypto.subtle.importKey(
    "raw",
    macRaw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return { encryptKey, macKey };
}

async function deriveMacRaw(seed: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", seed, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: utf8(ALERT_PURPOSE),
        info: utf8("mac"),
      },
      base,
      256,
    ),
  );
}

function evidenceInput(
  pkg: Omit<SealedAlertPackage, "evidenceMacB64">,
): Uint8Array {
  return utf8(
    JSON.stringify({
      purpose: EVIDENCE_PURPOSE,
      schemaVersion: pkg.schemaVersion,
      packageId: pkg.packageId,
      incidentId: pkg.incidentId,
      profileId: pkg.profileId,
      routeRef: pkg.routeRef,
      templateRef: pkg.templateRef,
      policyRevision: pkg.policyRevision,
      keyEpoch: pkg.keyEpoch,
      ciphertextB64: pkg.ciphertextB64,
      issuedAt: pkg.issuedAt,
      expiresAt: pkg.expiresAt,
      nonce: pkg.nonce,
    }),
  );
}

type AlertSealingKeyInput = Readonly<{
  encryptKey?: CryptoKey;
  macKey?: CryptoKey;
  sealingKey?: AlertSealingMaterial;
  signingKey?: CryptoKey;
}>;

type ResolvedAlertSealingKeys = Readonly<{
  encryptKey: CryptoKey;
  macKey: CryptoKey;
}>;

function resolveAlertSealingKeys(
  input: AlertSealingKeyInput,
): ResolvedAlertSealingKeys {
  const noRootCandidate = {} satisfies ProtectedRootAlertCandidate;
  rejectProtectedRootForAlert(noRootCandidate);
  if (input.signingKey && !input.encryptKey && !input.sealingKey) {
    throw new Error(
      "unsupported_factor: signingKey alone is unsupported; use importAlertSealingKey",
    );
  }
  const encryptKey = input.encryptKey ?? input.sealingKey?.encryptKey;
  const macKey = input.macKey ?? input.sealingKey?.macKey;
  if (!encryptKey || !macKey) {
    throw new Error(
      "unsupported_factor: alert sealing requires encryptKey+macKey",
    );
  }
  return { encryptKey, macKey } satisfies ResolvedAlertSealingKeys;
}

function assertValueBlindPayload(payload: AlertPayload): void {
  for (const [k, v] of Object.entries(payload)) {
    if (!isString(v)) {
      throw new Error("fail_closed: alert payload values must be strings");
    }
    if (/password|secret|rootKey|privateKey|token/i.test(k)) {
      throw new Error("unsupported_factor: alert payload must be value-blind");
    }
  }
}

async function encryptAlertBody(
  encryptKey: CryptoKey,
  body: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(ALERT_PURPOSE) },
      encryptKey,
      body,
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return packed;
}

export async function sealAlertPackage(input: {
  incidentId: string;
  profileId?: string;
  routeRef: string;
  templateRef: string;
  /** Preapproved minimal template fields only — value-blind. */
  payload: AlertPayload;
  encryptKey?: CryptoKey;
  macKey?: CryptoKey;
  /** Preferred: independent alert sealing material from importAlertSealingKey. */
  sealingKey?: AlertSealingMaterial;
  /**
   * @deprecated Legacy AES-GCM-only handle. Non-extractable keys cannot mint
   * authenticated evidence — callers must migrate to AlertSealingMaterial
   * (see .duress-swarm/requests/ALERT-to-CANARY.md).
   */
  signingKey?: CryptoKey;
  expiryMs: number;
  policyRevision?: number;
  keyEpoch?: number;
  now?: number;
  packageId?: string;
}): Promise<SealedAlertPackage> {
  const { encryptKey, macKey } = resolveAlertSealingKeys(input);
  const profileId = input.profileId ?? "unspecified";
  const policyRevision = input.policyRevision ?? 0;
  const keyEpoch = input.keyEpoch ?? 0;
  assertValueBlindPayload(input.payload);

  const now = input.now ?? Date.now();
  const nonce = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const packageId = input.packageId ?? `alert-${nonce.slice(0, 12)}`;
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + input.expiryMs).toISOString();

  const body = utf8(
    JSON.stringify({
      incidentId: input.incidentId,
      profileId,
      routeRef: input.routeRef,
      templateRef: input.templateRef,
      payload: input.payload,
      policyRevision,
      keyEpoch,
      nonce,
      issuedAt,
      expiresAt,
      packageId,
      purpose: ALERT_PURPOSE,
    }),
  );
  const packed = await encryptAlertBody(encryptKey, body);

  const unsigned: Omit<SealedAlertPackage, "evidenceMacB64"> = {
    schemaVersion: 1,
    packageId,
    incidentId: input.incidentId,
    profileId,
    routeRef: input.routeRef,
    templateRef: input.templateRef,
    policyRevision,
    keyEpoch,
    ciphertextB64: bytesToB64(packed),
    issuedAt,
    expiresAt,
    nonce,
  };
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", macKey, evidenceInput(unsigned)),
  );
  return { ...unsigned, evidenceMacB64: bytesToB64(mac) };
}

export async function verifyAlertEvidence(
  pkg: SealedAlertPackage,
  macKey: CryptoKey,
): Promise<boolean> {
  if (pkg.schemaVersion !== 1) return false;
  const { evidenceMacB64, ...rest } = pkg;
  return crypto.subtle.verify(
    "HMAC",
    macKey,
    b64ToBytes(evidenceMacB64),
    evidenceInput(rest),
  );
}

/** Decode ciphertext for authorized receivers — never uses vault root. */
export async function decodeCiphertext(
  pkg: SealedAlertPackage,
  encryptKey: CryptoKey,
): Promise<AlertPayload> {
  const packed = b64ToBytes(pkg.ciphertextB64);
  if (packed.length < 13) throw new Error("fail_closed: truncated package");
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: utf8(ALERT_PURPOSE) },
      encryptKey,
      ct,
    ),
  );
  const wire = JSON.parse(new TextDecoder().decode(plain));
  if (!isJsonObject(wire)) throw new Error("unsupported_factor");
  const parsed = overlapCast<JsonObject, { payload: AlertPayload }>(wire);
  return parsed.payload;
}

export type AlertEnrollmentSpec = Readonly<{
  routeRef: string;
  templateRef: string;
  maxRetries: number;
  expiryMs: number;
  retainOutboxAcrossRemoval: boolean;
}>;

/** Map enrollment alert spec fields into a seal call skeleton (no secrets). */
export function alertSpecFromEnrollment(
  spec: AlertEnrollmentSpec,
): AlertEnrollmentSpec {
  return { ...spec } satisfies AlertEnrollmentSpec;
}

/** Convenience: fresh independent alert sealing material (never vault root). */
export async function createAlertSealingKey(): Promise<AlertSealingMaterial> {
  return importAlertSealingKey(crypto.getRandomValues(new Uint8Array(32)));
}
