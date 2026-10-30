/**
 * Sealed persistence for Cloudflare temporary-account credentials.
 *
 * The temporary API token and claim URL are credentials: anyone with
 * the claim URL can take ownership of the account. They live only in a
 * `0600` file beside the reset config, never in the config, journal, or
 * output. The entry is dropped once it expires; a later allocation
 * with real credentials configured ignores it entirely.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudflareTemporaryAccount } from "@opensesame/agent-sandboxes";
import { z } from "zod";

const temporaryAccountSchema = z
  .object({
    accountId: z.string().min(1),
    apiToken: z.string().min(1),
    claimUrl: z.string().min(1),
    accountExpiresAt: z.string().min(1),
    claimExpiresAt: z.string().min(1),
  })
  .strict();

const CLOUDFLARE_STATE_FILE = ".cloudflare-agent-state.json";

export function loadCloudflareTemporaryAccount(
  directory: string,
): CloudflareTemporaryAccount | undefined {
  const path = join(directory, CLOUDFLARE_STATE_FILE);
  if (!existsSync(path)) return undefined;
  const parsed = temporaryAccountSchema.parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  const expires = Date.parse(parsed.accountExpiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return undefined;
  return parsed;
}

export function saveCloudflareTemporaryAccount(
  directory: string,
  account: CloudflareTemporaryAccount,
): void {
  writeFileSync(
    join(directory, CLOUDFLARE_STATE_FILE),
    JSON.stringify(account),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}
