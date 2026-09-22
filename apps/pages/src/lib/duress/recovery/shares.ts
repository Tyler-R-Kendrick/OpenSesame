/**
 * RECOVERY-C/D — threshold share envelopes over sops Shamir.
 * License/semantics: apps/pages/src/lib/sops/shamir.ts is a line-faithful port of
 * getsops/sops shamir (HashiCorp Vault Shamir, MPL-2.0). Share layout `{y…, x}`.
 * We authenticate context/generation with HMAC; we do not invent a new primitive.
 */

import { shamirCombine, shamirSplit } from "../../sops/shamir.js";
import { b64, fromB64, timingSafeEqual, wipe } from "./bytes.js";

export type ShareEnvelope = Readonly<{
  index: number;
  total: number;
  threshold: number;
  generation: number;
  vaultRef: string;
  compartmentRef: string;
  policyRevision: number;
  keyEpoch: number;
  /** Full SOPS share bytes (`y` bytes + `x` coordinate). */
  shareB64: string;
  macB64: string;
}>;

export type ShareContextExpect = Readonly<{
  generation: number;
  vaultRef: string;
  compartmentRef: string;
  policyRevision: number;
  keyEpoch: number;
  threshold: number;
}>;

async function macShare(
  key: Uint8Array,
  envelope: Omit<ShareEnvelope, "macB64">,
): Promise<string> {
  const ck = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = new TextEncoder().encode(
    JSON.stringify({
      index: envelope.index,
      total: envelope.total,
      threshold: envelope.threshold,
      generation: envelope.generation,
      vaultRef: envelope.vaultRef,
      compartmentRef: envelope.compartmentRef,
      policyRevision: envelope.policyRevision,
      keyEpoch: envelope.keyEpoch,
      shareB64: envelope.shareB64,
    }),
  );
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", ck, msg)));
}

/** Split a random recovery wrapping secret into authenticated share envelopes. */
export async function splitRecoverySecret(input: {
  secret: Uint8Array;
  threshold: number;
  total: number;
  generation: number;
  vaultRef: string;
  compartmentRef: string;
  policyRevision: number;
  keyEpoch: number;
  macKey: Uint8Array;
}): Promise<ShareEnvelope[]> {
  if (
    input.threshold < 2 ||
    input.total < input.threshold ||
    input.total > 16
  ) {
    throw new Error("unsupported_factor: share parameters");
  }
  if (input.secret.byteLength === 0) {
    throw new Error("unsupported_factor: empty recovery secret");
  }
  const parts = shamirSplit(input.secret, input.total, input.threshold);
  const shares: ShareEnvelope[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i];
    if (!raw) throw new Error("share missing");
    const x = raw[raw.byteLength - 1] ?? 0;
    const base = {
      index: x,
      total: input.total,
      threshold: input.threshold,
      generation: input.generation,
      vaultRef: input.vaultRef,
      compartmentRef: input.compartmentRef,
      policyRevision: input.policyRevision,
      keyEpoch: input.keyEpoch,
      shareB64: b64(raw),
    };
    const macB64 = await macShare(input.macKey, base);
    shares.push({ ...base, macB64 });
  }
  return shares;
}

export async function verifyShareEnvelope(
  share: ShareEnvelope,
  macKey: Uint8Array,
  expect: ShareContextExpect,
): Promise<Uint8Array> {
  if (share.generation !== expect.generation) {
    throw new Error("mixed_generations");
  }
  if (share.vaultRef !== expect.vaultRef) {
    throw new Error("scope_mismatch: vault");
  }
  if (share.compartmentRef !== expect.compartmentRef) {
    throw new Error("scope_mismatch: compartment");
  }
  if (share.policyRevision !== expect.policyRevision) {
    throw new Error("stale_policy");
  }
  if (share.keyEpoch !== expect.keyEpoch) {
    throw new Error("stale_session");
  }
  if (share.threshold !== expect.threshold) {
    throw new Error("unsupported_factor: threshold mismatch");
  }
  const { macB64: _m, ...base } = share;
  const mac = await macShare(macKey, base);
  if (!timingSafeEqual(fromB64(mac), fromB64(share.macB64))) {
    throw new Error("tampered_share");
  }
  const raw = fromB64(share.shareB64);
  if (raw.byteLength < 2)
    throw new Error("unsupported_factor: share too short");
  const x = raw[raw.byteLength - 1] ?? 0;
  if (x !== share.index) {
    throw new Error("tampered_share: index/coordinate mismatch");
  }
  return raw;
}

/** Reconstruct wrapping secret from authenticated envelopes (real Shamir combine). */
export async function combineRecoveryShares(input: {
  shares: ShareEnvelope[];
  macKey: Uint8Array;
  expect: ShareContextExpect;
}): Promise<Uint8Array> {
  const { shares, expect } = input;
  if (shares.length < expect.threshold) {
    throw new Error("recovery_required: insufficient shares");
  }
  const seen = new Set<number>();
  const rawParts: Uint8Array[] = [];
  for (const s of shares) {
    if (seen.has(s.index)) throw new Error("duplicate_share_index");
    seen.add(s.index);
    rawParts.push(await verifyShareEnvelope(s, input.macKey, expect));
  }
  const selected = rawParts.slice(0, expect.threshold);
  return shamirCombine(selected);
}

/**
 * Local store that refuses to retain enough plaintext shares to bypass the hold.
 * Ciphertext / sealed references may be cached; plaintext is wiped after use.
 */
export class LocalShareMaterialGuard {
  private plaintextCount = 0;
  private readonly threshold: number;
  private readonly plaintext: Uint8Array[] = [];

  constructor(threshold: number) {
    if (threshold < 2) throw new Error("unsupported_factor: threshold");
    this.threshold = threshold;
  }

  /**
   * Accept at most `threshold - 1` plaintext share bodies on this device.
   * Further plaintext staging fails closed.
   */
  stagePlaintextShare(shareBytes: Uint8Array): void {
    if (this.plaintextCount + 1 >= this.threshold) {
      throw new Error(
        "recovery_required: refusing to cache enough local plaintext shares to bypass",
      );
    }
    const copy = new Uint8Array(shareBytes);
    this.plaintext.push(copy);
    this.plaintextCount += 1;
  }

  stagedCount(): number {
    return this.plaintextCount;
  }

  clear(): void {
    for (const p of this.plaintext) wipe(p);
    this.plaintext.length = 0;
    this.plaintextCount = 0;
  }
}
