import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCloudflareTemporaryAccount,
  saveCloudflareTemporaryAccount,
} from "./cloudflare-provider-state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cf-state-"));
  directories.push(directory);
  return directory;
}

const ACCOUNT = {
  accountId: "acct-temp",
  apiToken: "temp-token",
  claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=abc",
  accountExpiresAt: "2999-01-01T00:00:00Z",
  claimExpiresAt: "2999-01-01T00:00:00Z",
};

describe("cloudflare temporary account persistence", () => {
  it("round-trips sealed beside the config and ignores expired accounts", async () => {
    const directory = await stateDir();
    expect(loadCloudflareTemporaryAccount(directory)).toBeUndefined();
    saveCloudflareTemporaryAccount(directory, ACCOUNT);
    expect(loadCloudflareTemporaryAccount(directory)).toEqual(ACCOUNT);
    const statePath = join(directory, ".cloudflare-agent-state.json");
    const mode = (await stat(statePath)).mode;
    expect(mode & 0o777).toBe(0o600);
    // Nothing rests in the clear: neither credential appears on disk.
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain(ACCOUNT.apiToken);
    expect(persisted).not.toContain("claimToken=abc");
    saveCloudflareTemporaryAccount(directory, {
      ...ACCOUNT,
      accountExpiresAt: "2000-01-01T00:00:00Z",
    });
    expect(loadCloudflareTemporaryAccount(directory)).toBeUndefined();
  });

  it("refuses forged or tampered temporary-account state", async () => {
    const directory = await stateDir();
    const statePath = join(directory, ".cloudflare-agent-state.json");
    // A pre-positioned plaintext account must never select the operator.
    await writeFile(
      statePath,
      JSON.stringify({
        accountId: "attacker-acct",
        apiToken: "attacker-token",
        claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=evil",
        accountExpiresAt: "2999-01-01T00:00:00Z",
        claimExpiresAt: "2999-01-01T00:00:00Z",
      }),
      { mode: 0o600 },
    );
    await chmod(statePath, 0o600);
    expect(() => loadCloudflareTemporaryAccount(directory)).toThrow(
      "could not be authenticated",
    );
    // Tampering with a genuinely sealed envelope also fails closed.
    saveCloudflareTemporaryAccount(directory, ACCOUNT);
    // SAFETY: checked at the test boundary: this file was written by saveCloudflareTemporaryAccount above, whose envelope shape is {sealed: string}.
    const sealed = JSON.parse(await readFile(statePath, "utf8")) as {
      sealed: string;
    };
    const flipped =
      sealed.sealed.slice(0, 20) +
      (sealed.sealed[20] === "A" ? "B" : "A") +
      sealed.sealed.slice(21);
    await writeFile(statePath, JSON.stringify({ ...sealed, sealed: flipped }), {
      mode: 0o600,
    });
    await chmod(statePath, 0o600);
    expect(() => loadCloudflareTemporaryAccount(directory)).toThrow(
      "could not be authenticated",
    );
  });
});
