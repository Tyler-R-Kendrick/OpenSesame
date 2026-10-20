/**
 * A vault's trusted-contact unlock policy: people from this vault's local
 * directory, and how many of them must authenticate after the primary unlock
 * before the vault opens. The policy is a sealed VFS file; member names are
 * read from the directory each time, never copied into the policy.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { readLocalPasskeys, requireLocalPerson } from "./local-credentials.js";
import { LocalDirectoryError, readLocalDirectory } from "./local-directory.js";
import { authenticateLocalPasskey } from "./local-passkeys.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/trusted-unlock";

/** Replaceable in tests: the passkey proof is a browser ceremony. */
export const trustedUnlockSeams: {
  authenticate: (tomb: string, principalId: string) => Promise<unknown>;
} = {
  authenticate: authenticateLocalPasskey,
};
const MAX_BYTES = 64_000;

export type TrustedUnlockPolicy = Readonly<{
  version: 1;
  name: string;
  threshold: number;
  memberIds: readonly string[];
  createdAt: string;
}>;

export type TrustedUnlockView = Readonly<{
  name: string;
  threshold: number;
  members: readonly Readonly<{ id: string; name: string }>[];
  approved: readonly string[];
}>;

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function parsePolicy(input: BoundaryValue): TrustedUnlockPolicy {
  const raw = input as unknown;
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { version?: unknown }).version !== 1 ||
    !validName((raw as { name?: unknown }).name) ||
    typeof (raw as { threshold?: unknown }).threshold !== "number" ||
    !Number.isSafeInteger((raw as { threshold?: number }).threshold) ||
    !Array.isArray((raw as { memberIds?: unknown }).memberIds) ||
    (raw as { memberIds: unknown[] }).memberIds.length > 64 ||
    !(raw as { memberIds: unknown[] }).memberIds.every(
      (id) => typeof id === "string" && /^local_[0-9a-f-]{36}$/.test(id),
    ) ||
    typeof (raw as { createdAt?: unknown }).createdAt !== "string"
  ) {
    throw new LocalDirectoryError(
      "The trusted-contact policy is invalid. Restore a valid vault backup.",
    );
  }
  const value = raw as TrustedUnlockPolicy;
  if (
    value.threshold < 1 ||
    value.threshold > value.memberIds.length ||
    new Set(value.memberIds).size !== value.memberIds.length
  ) {
    throw new LocalDirectoryError(
      "The trusted-contact policy has an impossible threshold.",
    );
  }
  return value;
}

export async function readTrustedUnlock(
  tomb: string,
): Promise<TrustedUnlockPolicy | null> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES) {
      throw new LocalDirectoryError(
        "The trusted-contact policy exceeds its size limit.",
      );
    }
    return parsePolicy(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
}

async function requireMembers(
  tomb: string,
  memberIds: readonly string[],
): Promise<void> {
  const directory = await readLocalDirectory(tomb);
  const passkeys = await readLocalPasskeys(tomb);
  for (const id of memberIds) {
    await requireLocalPerson(tomb, id);
    if (!directory.entries.some((entry) => entry.id === id && entry.enabled)) {
      throw new LocalDirectoryError("A trusted contact is disabled.");
    }
    if (!passkeys.some((key) => key.principalId === id)) {
      throw new LocalDirectoryError(
        "Every trusted contact needs an enrolled passkey first.",
      );
    }
  }
}

export async function writeTrustedUnlock(
  tomb: string,
  input: Readonly<{
    name: string;
    threshold: number;
    memberIds: readonly string[];
  }>,
): Promise<TrustedUnlockPolicy> {
  const memberIds = [...new Set(input.memberIds)];
  const policy = parsePolicy({
    version: 1,
    name: input.name.trim(),
    threshold: input.threshold,
    memberIds,
    createdAt: new Date().toISOString(),
  });
  await requireMembers(tomb, memberIds);
  const bytes = new TextEncoder().encode(JSON.stringify(policy));
  if (bytes.length > MAX_BYTES) {
    throw new LocalDirectoryError(
      "The trusted-contact policy exceeds its size limit.",
    );
  }
  await writeFile(tomb, PATH, bytes);
  return policy;
}

export async function clearTrustedUnlock(tomb: string): Promise<void> {
  const { deleteFile } = await import("./vfs.js");
  await deleteFile(tomb, PATH);
}

/** The policy with current names, and the identities that answered this unlock. */
export async function trustedUnlockView(
  tomb: string,
  policy: TrustedUnlockPolicy,
  approved: readonly string[],
): Promise<TrustedUnlockView> {
  const directory = await readLocalDirectory(tomb);
  const byId = new Map(
    directory.entries.map((entry) => [entry.id, entry.name]),
  );
  return {
    name: policy.name,
    threshold: policy.threshold,
    members: policy.memberIds.map((id) => ({
      id,
      name: byId.get(id) ?? "Missing contact",
    })),
    approved,
  };
}
