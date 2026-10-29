/** Plaintext Boat registration credentials protected by local file permissions. */
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { BoatProviderState } from "@opensesame/agent-sandboxes";
import { z } from "zod";

const stateSchema = z
  .object({
    claimToken: z.string().min(1).max(32768).optional(),
    identityAssertion: z.string().min(1).max(32768).optional(),
    claimIssuedAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    claimMaterials: z
      .object({
        claimToken: z.string().min(1).max(32768),
        userCode: z.string().min(1).max(128),
        verificationUri: z.string().min(1).max(4096),
        expiresIn: z
          .number()
          .finite()
          .positive()
          .max(Number.MAX_SAFE_INTEGER / 1000),
        interval: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const STATE = ".boat-agent-state.json";
const LOCK = ".boat-agent-state.lock";
const MAX_STATE_BYTES = 128 * 1024;

function secureDirectory(directory: string): string {
  if (
    typeof process.getuid !== "function" ||
    constants.O_NOFOLLOW === undefined
  )
    throw new Error(
      "Boat state requires POSIX file permission and no-follow support",
    );
  const resolved = realpathSync(directory);
  let ancestor = dirname(resolved);
  for (;;) {
    const parent = lstatSync(ancestor);
    const trustedOwner = parent.uid === 0 || parent.uid === process.getuid();
    const writable = (parent.mode & 0o022) !== 0;
    const sticky = (parent.mode & 0o1000) !== 0;
    if (!parent.isDirectory() || !trustedOwner || (writable && !sticky))
      throw new Error(
        "Boat state directory has an untrusted or writable non-sticky ancestor",
      );
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  const stat = lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error(
      "Boat state directory must be owned by the current user and not group/world writable",
    );
  return resolved;
}

function openExisting(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > MAX_STATE_BYTES
    )
      throw new Error(
        "Boat state file must be a private 0600 regular file owned by the current user",
      );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function loadBoatProviderState(directory: string): BoatProviderState {
  const path = join(secureDirectory(directory), STATE);
  const fd = openExisting(path);
  if (fd === undefined) return {};
  try {
    const parsed = stateSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    const state: BoatProviderState = {};
    if (parsed.claimToken !== undefined) state.claimToken = parsed.claimToken;
    if (parsed.identityAssertion !== undefined)
      state.identityAssertion = parsed.identityAssertion;
    if (parsed.claimMaterials !== undefined)
      state.claimMaterials = parsed.claimMaterials;
    if (parsed.claimIssuedAt !== undefined)
      state.claimIssuedAt = parsed.claimIssuedAt;
    return state;
  } finally {
    closeSync(fd);
  }
}

export function saveBoatProviderState(
  directory: string,
  state: BoatProviderState,
): void {
  const dir = secureDirectory(directory);
  const path = join(dir, STATE);
  const valid = stateSchema.parse(state);
  const serialized = JSON.stringify(valid);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES)
    throw new Error("Boat state exceeds the maximum encoded size");
  const old = openExisting(path);
  if (old !== undefined) closeSync(old);
  const temp = join(
    dir,
    `.boat-agent-state.${randomBytes(16).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const dirFd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

/** A stale lock requires manual recovery after confirming no allocation is active. */
export function acquireBoatStateLock(directory: string): () => void {
  const dir = secureDirectory(directory);
  const path = join(dir, LOCK);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "Boat state is locked by another run; after confirming none is running, remove .boat-agent-state.lock",
      );
    throw error;
  }
  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}

export async function withBoatStateLock<T>(
  directory: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = acquireBoatStateLock(directory);
  try {
    return await fn();
  } finally {
    release();
  }
}
