/**
 * The deadman release package (ADR 0209).
 *
 * A package is a snapshot of the items the owner chose, sealed under a random
 * 256-bit release key with AES-256-GCM. The release key is shown once and is
 * never stored on this device. The package itself is a device-local KV value
 * sealed again at rest; it carries no vault key and opens while the vault is
 * locked.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { isJsonObject, isNumber, isString } from "@opensesame/os-domain";
import {
  b64urlToBytes,
  randomString,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import {
  type SealedBlob,
  type VaultItem,
  importVaultKey,
  openJson,
  sealJson,
} from "@opensesame/vault-core";
import { kvDeleteDurable, kvGet, kvSetDurable } from "../kv.js";
import {
  DEADMAN_MAX_ITEMS,
  DEADMAN_MAX_PACKAGE_BYTES,
  deadmanPackageKey,
} from "./keys.js";

const PACKAGE_PREFIX = "osdm1_";

export type DeadmanPackage = Readonly<{
  v: 1;
  id: string;
  createdAt: string;
  itemCount: number;
  ivB64: string;
  ctB64: string;
  digest: string;
}>;

type DeadmanPayload = {
  v: 1;
  id: string;
  createdAt: string;
  items: VaultItem[];
};

export type DeadmanSealedPackage = Readonly<{
  package: DeadmanPackage;
  packageJson: string;
  releaseKey: string;
}>;

function binding(tomb: string, id: string): string {
  return `deadman-package\u0000${tomb}\u0000${id}`;
}

function digestOf(
  packageValue: Pick<DeadmanPackage, "id" | "ivB64" | "ctB64">,
) {
  return sha256Base64Url(
    JSON.stringify({
      id: packageValue.id,
      ivB64: packageValue.ivB64,
      ctB64: packageValue.ctB64,
    }),
  );
}

export function normalizeReleaseKey(value: string): string {
  const compact = value.replace(/\s+/gu, "");
  if (!new RegExp(`^${PACKAGE_PREFIX}[A-Za-z0-9_-]{43}$`, "u").test(compact)) {
    throw new Error(
      "Enter the 49-character release key, starting with osdm1_.",
    );
  }
  return compact;
}

/** The raw key bytes, after the one accepted prefix and whitespace. */
export function releaseKeyBytes(value: string): Uint8Array {
  const compact = normalizeReleaseKey(value);
  const bytes = b64urlToBytes(compact.slice(PACKAGE_PREFIX.length));
  if (bytes.byteLength !== 32)
    throw new Error("That release key is incomplete.");
  return bytes;
}

/** Seal a fresh package. The returned release key must leave this device. */
export async function sealDeadmanPackage(input: {
  tomb: string;
  id: string;
  createdAt: string;
  items: readonly VaultItem[];
}): Promise<DeadmanSealedPackage> {
  if (input.items.length === 0 || input.items.length > DEADMAN_MAX_ITEMS) {
    throw new Error(
      `Choose between 1 and ${DEADMAN_MAX_ITEMS} items for the deadman switch.`,
    );
  }
  const releaseKey = `${PACKAGE_PREFIX}${randomString(32)}`;
  const key = await importVaultKey(releaseKeyBytes(releaseKey));
  const payload: DeadmanPayload = {
    v: 1,
    id: input.id,
    createdAt: input.createdAt,
    items: input.items.map(
      (item) => JSON.parse(JSON.stringify(item)) as VaultItem,
    ),
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 1_000_000)
    throw new Error(
      "The selected items are too large for one release package.",
    );
  const sealed = await sealJson(
    key,
    payload as unknown as BoundaryValue,
    binding(input.tomb, input.id),
  );
  const packageValue: DeadmanPackage = {
    v: 1,
    id: input.id,
    createdAt: input.createdAt,
    itemCount: payload.items.length,
    ivB64: sealed.ivB64,
    ctB64: sealed.ctB64,
    digest: await digestOf({
      id: input.id,
      ivB64: sealed.ivB64,
      ctB64: sealed.ctB64,
    }),
  };
  const packageJson = JSON.stringify(packageValue);
  if (
    new TextEncoder().encode(packageJson).byteLength > DEADMAN_MAX_PACKAGE_BYTES
  )
    throw new Error(
      "The selected items are too large for one release package.",
    );
  // Prove the displayed key opens exactly this package before anything is
  // written or sent to a relay.
  const opened = await openJson<DeadmanPayload>(
    key,
    sealed,
    binding(input.tomb, input.id),
  );
  if (opened.items.length !== payload.items.length || opened.id !== input.id)
    throw new Error("The release package did not read back.");
  return { package: packageValue, packageJson, releaseKey };
}

export function parseDeadmanPackage(raw: string | null): DeadmanPackage | null {
  if (!raw) return null;
  try {
    const value: BoundaryValue = JSON.parse(raw);
    if (
      !isJsonObject(value) ||
      value.v !== 1 ||
      !isString(value.id) ||
      value.id.length > 80 ||
      !isString(value.createdAt) ||
      value.createdAt.length > 80 ||
      !isNumber(value.itemCount) ||
      !Number.isSafeInteger(value.itemCount) ||
      value.itemCount < 1 ||
      value.itemCount > DEADMAN_MAX_ITEMS ||
      !isString(value.ivB64) ||
      value.ivB64.length > 64 ||
      !isString(value.ctB64) ||
      value.ctB64.length > 2_800_000 ||
      !isString(value.digest) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.digest)
    )
      return null;
    return value as DeadmanPackage;
  } catch {
    return null;
  }
}

export function readDeadmanPackage(tomb: string): DeadmanPackage | null {
  return parseDeadmanPackage(kvGet(deadmanPackageKey(tomb)));
}

export async function writeDeadmanPackage(
  tomb: string,
  packageJson: string,
): Promise<void> {
  await kvSetDurable(deadmanPackageKey(tomb), packageJson);
}

export async function deleteDeadmanPackage(tomb: string): Promise<void> {
  await kvDeleteDurable(deadmanPackageKey(tomb));
}

/** Open a package only after its digest and its release key both check out. */
export async function openDeadmanPackage(
  tomb: string,
  packageValue: DeadmanPackage,
  releaseKey: string,
): Promise<VaultItem[]> {
  const expected = await digestOf(packageValue);
  if (expected !== packageValue.digest)
    throw new Error("The release package was changed after it was sealed.");
  const key = await importVaultKey(releaseKeyBytes(releaseKey));
  let payload: DeadmanPayload;
  try {
    payload = await openJson<DeadmanPayload>(
      key,
      {
        ivB64: packageValue.ivB64,
        ctB64: packageValue.ctB64,
      } satisfies SealedBlob,
      binding(tomb, packageValue.id),
    );
  } catch {
    throw new Error("That release key did not open this deadman switch.");
  }
  if (
    payload.v !== 1 ||
    payload.id !== packageValue.id ||
    !Array.isArray(payload.items) ||
    payload.items.length !== packageValue.itemCount
  )
    throw new Error("The release package did not read back.");
  return payload.items;
}
