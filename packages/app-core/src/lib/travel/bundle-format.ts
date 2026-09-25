/**
 * The travel bundle: every stored file of the vaults that left this device,
 * sealed once more under the return code's key (ADR 0143).
 *
 * The files inside are what the origin held — a vault's ciphertext, its
 * plaintext header, its lockout counter — byte for byte, so a vault comes
 * home exactly as it left. Outside the seal there is a format tag, a version
 * and a random id; nothing names a vault, a count or a date.
 *
 * A bundle is read as hostile input: whoever hands one over might have
 * written it. Every file it carries must sit in the namespace of the vault
 * it claims to belong to, so a bundle can put a vault back and can never
 * overwrite anything else this origin stores (settings, the duress fence,
 * the tomb registry).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type SealedBlob, openJson, sealJson } from "@opensesame/vault-core";
import { type ReturnSecret, deriveBundleKey } from "./return-code.js";

export const TRAVEL_BUNDLE_FORMAT = "opensesame.travel-bundle";
export const TRAVEL_BUNDLE_VERSION = 1;
/** Refuse anything larger before parsing it. */
export const MAX_TRAVEL_BUNDLE_BYTES = 64 * 1024 * 1024;

export type TravelVaultKind = "personal" | "project";

export type TravelFile = Readonly<{ file: string; text: string }>;

export type TravelVault = Readonly<{
  id: string;
  kind: TravelVaultKind;
  /** The sealed name when the departing session knew it; shown on return. */
  name: string | null;
  files: readonly TravelFile[];
}>;

export type TravelPayload = Readonly<{
  v: 1;
  bundleId: string;
  departedAt: string;
  vaults: readonly TravelVault[];
}>;

export type TravelBundleErrorCode =
  | "bundle_malformed"
  | "bundle_too_large"
  | "unsupported_version"
  | "code_mismatch"
  | "foreign_file";

export class TravelBundleError extends Error {
  readonly code: TravelBundleErrorCode;

  constructor(code: TravelBundleErrorCode, message: string) {
    super(message);
    this.name = "TravelBundleError";
    this.code = code;
  }
}

const TOMB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Never carried, never restored: session roads, not vaults. */
const NOT_VAULTS = new Set(["guest", "guest-scratch"]);

function binding(bundleId: string): string {
  return `${TRAVEL_BUNDLE_FORMAT}:v${TRAVEL_BUNDLE_VERSION}:${bundleId}`;
}

export function newBundleId(): string {
  return `trv_${crypto.randomUUID()}`;
}

/** What a travel bundle file is called — no vault, date or count in it. */
export function bundleFileName(bundleId: string): string {
  return `opensesame-${bundleId.replace(/^trv_/, "").slice(0, 8)}.travel.json`;
}

export async function sealTravelBundle(
  payload: TravelPayload,
  secret: ReturnSecret,
): Promise<string> {
  const key = await deriveBundleKey(secret, payload.bundleId);
  const value: BoundaryValue = {
    v: payload.v,
    bundleId: payload.bundleId,
    departedAt: payload.departedAt,
    vaults: payload.vaults.map((vault) => ({
      id: vault.id,
      kind: vault.kind,
      name: vault.name,
      files: vault.files.map((entry) => ({
        file: entry.file,
        text: entry.text,
      })),
    })),
  };
  const sealed = await sealJson(key, value, binding(payload.bundleId));
  return JSON.stringify({
    format: TRAVEL_BUNDLE_FORMAT,
    v: TRAVEL_BUNDLE_VERSION,
    bundleId: payload.bundleId,
    sealed,
  });
}

function readEnvelope(json: string) {
  if (json.length > MAX_TRAVEL_BUNDLE_BYTES) {
    throw new TravelBundleError(
      "bundle_too_large",
      "That file is larger than any travel bundle.",
    );
  }
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  if (!isJsonObject(parsed) || parsed.format !== TRAVEL_BUNDLE_FORMAT) {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  if (parsed.v !== TRAVEL_BUNDLE_VERSION) {
    throw new TravelBundleError(
      "unsupported_version",
      "This travel bundle was written by a newer version.",
    );
  }
  const sealed = parsed.sealed;
  if (
    !isString(parsed.bundleId) ||
    !isJsonObject(sealed) ||
    !isString(sealed.ivB64) ||
    !isString(sealed.ctB64)
  ) {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  const blob: SealedBlob = { ivB64: sealed.ivB64, ctB64: sealed.ctB64 };
  return { bundleId: parsed.bundleId, sealed: blob };
}

/** Which of a vault's files a bundle may carry for it. */
export type VaultNamespace = (vaultId: string, file: string) => boolean;

function readFiles(raw: BoundaryValue, id: string, owns: VaultNamespace) {
  if (!Array.isArray(raw)) {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  return raw.map((entry): TravelFile => {
    if (!isJsonObject(entry) || !isString(entry.file) || !isString(entry.text))
      throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
    if (!owns(id, entry.file)) {
      throw new TravelBundleError(
        "foreign_file",
        "This bundle carries a file that belongs to no vault in it.",
      );
    }
    return { file: entry.file, text: entry.text };
  });
}

function readVault(raw: BoundaryValue, owns: VaultNamespace): TravelVault {
  if (
    !isJsonObject(raw) ||
    !isString(raw.id) ||
    !TOMB_ID_RE.test(raw.id) ||
    NOT_VAULTS.has(raw.id) ||
    (raw.kind !== "personal" && raw.kind !== "project")
  ) {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  return {
    id: raw.id,
    kind: raw.kind,
    name: isString(raw.name) ? raw.name : null,
    files: readFiles(raw.files, raw.id, owns),
  };
}

/**
 * Open a bundle with its return code. A wrong code and a tampered bundle
 * are the same failure — AES-GCM cannot tell them apart, and neither can we.
 */
export async function openTravelBundle(
  json: string,
  secret: ReturnSecret,
  owns: VaultNamespace,
): Promise<TravelPayload> {
  const envelope = readEnvelope(json);
  const key = await deriveBundleKey(secret, envelope.bundleId);
  let raw: BoundaryValue;
  try {
    raw = await openJson<BoundaryValue>(
      key,
      envelope.sealed,
      binding(envelope.bundleId),
    );
  } catch {
    throw new TravelBundleError(
      "code_mismatch",
      "That return code does not open this bundle.",
    );
  }
  if (
    !isJsonObject(raw) ||
    raw.v !== 1 ||
    raw.bundleId !== envelope.bundleId ||
    !isString(raw.departedAt) ||
    !Array.isArray(raw.vaults)
  ) {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  const vaults = raw.vaults.map((vault) => readVault(vault, owns));
  if (new Set(vaults.map((vault) => vault.id)).size !== vaults.length) {
    throw new TravelBundleError("bundle_malformed", "Not a travel bundle.");
  }
  return {
    v: 1,
    bundleId: envelope.bundleId,
    departedAt: raw.departedAt,
    vaults,
  };
}
