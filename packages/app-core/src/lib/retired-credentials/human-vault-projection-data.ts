/** Inactive projection authentication data. A supplied root cannot issue an owner/REAL permit. */
import { overlapCast } from "@opensesame/os-domain";
import {
  ROOT_KEY_BYTES,
  bytesToB64,
  importVaultKey,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { openAuthenticationProjection } from "../secret-fs/authentication-projection.js";
import {
  type HumanVaultDataMetadata,
  verifyHumanVaultData,
} from "./human-vault-data.js";

// Capture concrete keyed operations before any caller-derived root enters.
const actualImportKey = importVaultKey;
const actualOpenProjection = openAuthenticationProjection;
const actualSeal = sealJson;
const actualBinding = vaultSealBinding;
const actualVerify = verifyHumanVaultData;
const actualEncode = bytesToB64;
const actualDigest = crypto.subtle.digest.bind(crypto.subtle);

/** The issuer must derive the root itself, then revalidate its original physical snapshot. */
export async function verifyHumanVaultProjectionData(
  tomb: string,
  header: string,
  wire: string,
  derivedRoot: Uint8Array,
): Promise<HumanVaultDataMetadata> {
  if (derivedRoot.length !== ROOT_KEY_BYTES)
    throw new Error("Human projection data is unavailable.");
  const root = derivedRoot.slice();
  try {
    const key = await actualImportKey(root);
    // First authenticate actual encrypted manifest/documents and their exact path AAD.
    const body = await actualOpenProjection(tomb, wire, key);
    // Reuse the existing complete manifest-MAC/gates/body-revision verifier on
    // the actual authenticated body. This temporary seal is never storage or authority.
    const sealed = await actualSeal(key, body, actualBinding(tomb, "body"));
    const metadata = await actualVerify(tomb, header, sealed, root);
    const digest = await actualDigest(
      "SHA-256",
      overlapCast(new TextEncoder().encode(wire)),
    );
    return Object.freeze({
      ...metadata,
      bodyDigestB64: actualEncode(new Uint8Array(digest)),
    });
  } finally {
    root.fill(0);
  }
}
