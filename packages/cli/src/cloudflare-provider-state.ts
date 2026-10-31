/**
 * Sealed persistence for Cloudflare temporary-account credentials.
 *
 * The temporary API token and claim URL are credentials: anyone with
 * the claim URL can take ownership of the account, and forged state
 * would choose whose Cloudflare account the reset runs in. The
 * account therefore rests only as an authenticated local envelope
 * (the CLI at-rest sealing mechanism) in a private `0600` file beside
 * the reset config, opened no-follow from a trusted directory. The
 * envelope key lives in its own `0600` file, never in the config,
 * journal, or output. The entry is dropped once it expires; a later
 * allocation with real credentials configured ignores it entirely.
 */

import { closeSync } from "node:fs";
import { join } from "node:path";
import type { CloudflareTemporaryAccount } from "@opensesame/agent-sandboxes";
import { loadAtRestKeyFile } from "@opensesame/app-core/node/at-rest-key-file.js";
import {
  openLocalEnvelope,
  sealLocalEnvelope,
} from "@opensesame/app-core/node/local-envelope.js";
import { z } from "zod";
import {
  openPrivateStateFile,
  readPrivateStateFile,
  secureStateDirectory,
  writePrivateStateAtomically,
} from "./private-state-file.js";

const LABEL = "Cloudflare";
const STATE_FILE = ".cloudflare-agent-state.json";
const KEY_FILE = ".cloudflare-agent-state.key";
const MAX_STATE_BYTES = 128 * 1024;

const temporaryAccountSchema = z
  .object({
    accountId: z.string().min(1).max(128),
    apiToken: z.string().min(1).max(4096),
    claimUrl: z.string().min(1).max(8192),
    accountExpiresAt: z.string().min(1).max(64),
    claimExpiresAt: z.string().min(1).max(64),
  })
  .strict();

const envelopeSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().min(1).max(128),
    sealed: z.string().min(1).max(MAX_STATE_BYTES),
  })
  .strict();

function binding(accountId: string): string {
  return JSON.stringify(["cli_cloudflare_temporary_account", accountId]);
}

function stateRoot(dir: string, create: boolean): Uint8Array {
  const keyPath = join(dir, KEY_FILE);
  const existing = openPrivateStateFile(keyPath, LABEL, MAX_STATE_BYTES);
  if (existing !== undefined) closeSync(existing);
  else if (!create)
    throw new Error("Cloudflare state envelope root is missing");
  return loadAtRestKeyFile(keyPath);
}

export function loadCloudflareTemporaryAccount(
  directory: string,
): CloudflareTemporaryAccount | undefined {
  const dir = secureStateDirectory(directory, LABEL);
  const raw = readPrivateStateFile(
    join(dir, STATE_FILE),
    LABEL,
    MAX_STATE_BYTES,
  );
  if (raw === undefined) return undefined;
  const unauthenticated = new Error(
    "Cloudflare state could not be authenticated; after confirming no allocation is active, remove .cloudflare-agent-state.json and retry",
  );
  let outer: z.infer<typeof envelopeSchema>;
  try {
    outer = envelopeSchema.parse(JSON.parse(raw));
  } catch {
    throw unauthenticated;
  }
  const root = stateRoot(dir, false);
  let plaintext: string | null;
  try {
    plaintext = openLocalEnvelope(root, binding(outer.accountId), outer.sealed);
  } finally {
    root.fill(0);
  }
  if (plaintext === null) throw unauthenticated;
  let parsed: CloudflareTemporaryAccount;
  try {
    parsed = temporaryAccountSchema.parse(JSON.parse(plaintext));
  } catch {
    throw unauthenticated;
  }
  if (parsed.accountId !== outer.accountId) throw unauthenticated;
  const expires = Date.parse(parsed.accountExpiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return undefined;
  return parsed;
}

export function saveCloudflareTemporaryAccount(
  directory: string,
  account: CloudflareTemporaryAccount,
): void {
  const dir = secureStateDirectory(directory, LABEL);
  const valid = temporaryAccountSchema.parse(account);
  const root = stateRoot(dir, true);
  let sealed: string;
  try {
    sealed = sealLocalEnvelope(
      root,
      binding(valid.accountId),
      JSON.stringify(valid),
    );
  } finally {
    root.fill(0);
  }
  const serialized = JSON.stringify({
    version: 1,
    accountId: valid.accountId,
    sealed,
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES)
    throw new Error("Cloudflare state exceeds the maximum encoded size");
  writePrivateStateAtomically(
    dir,
    join(dir, STATE_FILE),
    serialized,
    ".cloudflare-agent-state",
  );
}
