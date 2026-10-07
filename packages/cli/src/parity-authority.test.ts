import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processFixture } from "./fixtures/password-agent/process.js";
import { createCredentialStore } from "./parity-credentials.js";
import { invokeOp, writePrivateFile } from "./parity-node.js";
import { requestAddresses } from "./parity-request-node.js";
import { runParity } from "./parity.js";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault } from "./vault-session.js";

const PASSWORD = "current owner proof password 891";
let owner: VaultStore;
let directory: string;
let provider: Awaited<ReturnType<typeof processFixture>>;

async function resumeOwner(): Promise<void> {
  owner.lock();
  owner.rehydrate();
  await owner.unlock(PASSWORD);
}

describe("password-agent real-session descendants", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "os-parity-authority-"));
    owner = await openLocalVault(directory);
    await owner.create(PASSWORD);
    provider = await processFixture();
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", undefined);
    for (const name of ["PATH", "PARITY_DB", "PARITY_LOG"])
      vi.stubEnv(name, provider.env[name]);
  });
  afterEach(async () => {
    await resumeOwner();
    await releaseVaultKv();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
    await rm(provider.directory, { recursive: true, force: true });
  });

  it("blocks real provider and private IO in synthetic and locked recovery states, then accepts actual owner authentication", async () => {
    expect(await invokeOp(["read", "op://v/i/f"])).toBe("private-canary\n");
    owner.lock();
    await owner.createGuest({ decoy: true, isolated: true });
    const output = join(directory, "forbidden-secret");
    for (const locked of [false, true]) {
      if (locked) owner.lock();
      await expect(
        runParity({
          name: "parity",
          verb: "read",
          args: ["op://v/i/f", "--desktop"],
          flags: { json: false },
        }),
      ).rejects.toThrow();
      await expect(invokeOp(["read", "op://v/i/f"])).rejects.toThrow();
      await expect(
        writePrivateFile(output, "must-not-materialize"),
      ).rejects.toThrow();
      await expect(requestAddresses("example.com")).rejects.toThrow();
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await provider.calls()).toHaveLength(1);
    await resumeOwner();
    expect(await invokeOp(["read", "op://v/i/f"])).toBe("private-canary\n");
    expect(await provider.calls()).toHaveLength(2);
  });

  it("refuses Windows private publication before replacing a file or creating a pending plaintext file", async () => {
    const target = join(directory, "private-output");
    await writePrivateFile(target, "original");
    const before = await readdir(directory);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!descriptor) throw new Error("Missing process platform descriptor");
    try {
      Object.defineProperty(process, "platform", {
        ...descriptor,
        value: "win32",
      });
      await expect(
        writePrivateFile(target, "private-replacement"),
      ).rejects.toThrow("native opensesame CLI");
      expect(await readFile(target, "utf8")).toBe("original");
      expect(await readdir(directory)).toEqual(before);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("does not read, overwrite, or delete saved credentials during synthetic recovery", async () => {
    if (process.platform !== "linux") return;
    const storage = createCredentialStore(directory);
    await storage.saveToken("ops_saved_original");
    const file = join(directory, "password-agent", "token");
    const original = await readFile(file, "utf8");
    owner.lock();
    await owner.createGuest({ decoy: true, isolated: true });
    owner.lock();
    await expect(storage.loadToken()).rejects.toThrow();
    await expect(
      storage.saveToken("ops_attacker_replacement"),
    ).rejects.toThrow();
    await expect(storage.removeToken()).rejects.toThrow();
    await expect(
      storage.saveSettings({ name: "attacker", vaults: [] }),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(original);
    await resumeOwner();
    expect(await storage.loadToken()).toBe("ops_saved_original");
  });

  it("withholds actual provider plaintext after synthetic-to-real ABA instead of admitting an old continuation", async () => {
    let ready = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const result = runParity(
      {
        name: "parity",
        verb: "read",
        args: ["op://v/i/f", "--desktop"],
        flags: { json: false },
      },
      {
        parityPort: {
          invoke: async (args, options) => {
            const output = await invokeOp(args, options);
            ready();
            await paused;
            return output;
          },
        },
      },
    );
    const rejected = expect(result).rejects.toThrow();
    await entered;
    owner.lock();
    await owner.createGuest({ decoy: true, isolated: true });
    await resumeOwner();
    release();
    await rejected;
    expect(stdout).not.toHaveBeenCalled();
    expect(await provider.calls()).toHaveLength(1);
    expect(await invokeOp(["read", "op://v/i/f"])).toBe("private-canary\n");
  });
});
