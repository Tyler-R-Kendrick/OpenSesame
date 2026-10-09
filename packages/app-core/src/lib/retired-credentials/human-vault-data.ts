/** Inactive data authentication only. Derived key possession is not owner authority. */
import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type AuthenticatedLegacyGates,
  MAX_MANIFEST_ENCODED_BYTES,
  ROOT_KEY_BYTES,
  type RootProtectionManifest,
  type SealedBlob,
  b64ToBytes,
  bytesToB64,
  importVaultKey,
} from "@opensesame/vault-core";
import { z } from "zod";
import { verifyManifestAuth } from "../vault/protection/manifest-auth.js";
import { parseRootProtectionManifest } from "../vault/protection/parse.js";
import {
  MAX_HUMAN_BODY_BYTES,
  openBoundHumanVaultBodyData,
} from "./human-vault-body-data.js";
import { assertUnambiguousJson } from "./json-preflight.js";

const revision = z.number().int().nonnegative().safe();
const gates = z
  .object({
    totpEnrolled: z.boolean(),
    emailEnrolled: z.boolean(),
    smsEnrolled: z.boolean(),
    recoveryCodesEnrolled: z.boolean(),
  })
  .strict();
const gateRecord = z.object({}).passthrough().optional();
const headerSchema = z
  .object({
    v: z.literal(1),
    bodyRev: revision.optional(),
    protection: z.object({ legacyGates: gates }).passthrough(),
    unlocks: z
      .object({
        totp: gateRecord,
        email: gateRecord,
        sms: gateRecord,
        recovery: gateRecord,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type HumanVaultDataMetadata = Readonly<{
  vaultId: string;
  rootKeyId: string;
  rootEpoch: number;
  manifestRevision: number;
  bodyRevision: number;
  /** Snapshot fingerprints, not a MAC over the outer header or an owner permit. */
  headerDigestB64: string;
  bodyDigestB64: string;
  gates: Readonly<z.infer<typeof gates>>;
}>;

function unavailable(): never {
  throw new Error("Human vault data is unavailable.");
}

function canonicalBytes(text: string, min: number, max: number): void {
  if (text.length > Math.ceil(max / 3) * 4) unavailable();
  const bytes = b64ToBytes(text);
  if (bytes.length < min || bytes.length > max || bytesToB64(bytes) !== text)
    unavailable();
}

function exactId(text: string): void {
  if (!text.length || text.length > 256) unavailable();
  if (new TextEncoder().encode(text).length > 256) unavailable();
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hashed = await crypto.subtle.digest("SHA-256", overlapCast(bytes));
  return bytesToB64(new Uint8Array(hashed));
}

type HumanHeaderData = Readonly<{
  manifest: RootProtectionManifest;
  policy: AuthenticatedLegacyGates;
  minimumBodyRevision: number;
}>;

function readHumanHeaderData(headerText: string): HumanHeaderData {
  assertUnambiguousJson(headerText, MAX_MANIFEST_ENCODED_BYTES);
  const header = headerSchema.parse(JSON.parse(headerText));
  const manifest = parseRootProtectionManifest(
    JSON.stringify(header.protection),
  );
  if (manifest.purpose !== "human-vault-root") unavailable();
  exactId(manifest.vaultId);
  exactId(manifest.rootKeyId);
  canonicalBytes(manifest.authB64 ?? "", 32, 32);
  const policy = header.protection.legacyGates;
  if (
    policy.totpEnrolled !== (header.unlocks?.totp !== undefined) ||
    policy.emailEnrolled !== (header.unlocks?.email !== undefined) ||
    policy.smsEnrolled !== (header.unlocks?.sms !== undefined) ||
    policy.recoveryCodesEnrolled !== (header.unlocks?.recovery !== undefined)
  )
    unavailable();
  return { manifest, policy, minimumBodyRevision: header.bodyRev ?? 0 };
}

function readBodyRevision(opened: BoundaryValue, minimum: number): number {
  if (
    !isJsonObject(opened) ||
    opened.v !== 1 ||
    !Array.isArray(opened.items) ||
    !Array.isArray(opened.folders)
  )
    unavailable();
  const bodyRevision = revision.parse(
    opened.rev === undefined ? 0 : opened.rev,
  );
  if (bodyRevision < minimum) unavailable();
  return bodyRevision;
}

/**
 * Verify a storage snapshot with an already-derived root. Returns metadata only,
 * not the root, plaintext, factors-complete verdict, challenge proof or permit.
 * Caller owns original context, entry provenance, fresh factors and later recheck.
 */
export async function verifyHumanVaultData(
  tomb: string,
  headerText: string,
  sealedBody: SealedBlob | null,
  derivedRoot: Uint8Array,
): Promise<HumanVaultDataMetadata> {
  let root: Uint8Array | undefined;
  try {
    if (
      !(derivedRoot instanceof Uint8Array) ||
      derivedRoot.length !== ROOT_KEY_BYTES ||
      sealedBody === null
    )
      unavailable();
    // Validate the exact tomb as JSON text, including Unicode, before AAD encoding.
    exactId(tomb);
    assertUnambiguousJson(JSON.stringify(tomb), 2048);
    const { manifest, policy, minimumBodyRevision } =
      readHumanHeaderData(headerText);
    // Snapshot primitives and root before the first asynchronous operation.
    const body = { ivB64: sealedBody.ivB64, ctB64: sealedBody.ctB64 };
    canonicalBytes(body.ivB64, 12, 12);
    canonicalBytes(body.ctB64, 16, MAX_HUMAN_BODY_BYTES);
    root = new Uint8Array(derivedRoot);
    await verifyManifestAuth(root, manifest);
    const key = await importVaultKey(root);
    const opened = await openBoundHumanVaultBodyData(key, body, tomb);
    const bodyRevision = readBodyRevision(opened, minimumBodyRevision);
    return Object.freeze({
      vaultId: manifest.vaultId,
      rootKeyId: manifest.rootKeyId,
      rootEpoch: manifest.rootEpoch,
      manifestRevision: manifest.revision,
      bodyRevision,
      headerDigestB64: await digest(headerText),
      bodyDigestB64: await digest(JSON.stringify(body)),
      gates: Object.freeze({ ...policy }),
    });
  } catch {
    return unavailable();
  } finally {
    root?.fill(0);
  }
}
