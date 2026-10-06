import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "./parity-credentials.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe("password-agent credential storage", () => {
  it("service.storage-readback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "os-password-agent-"));
    directories.push(directory);
    const store = createCredentialStore(directory);
    if (process.platform !== "linux") return;
    expect(await store.hasToken()).toBe(false);
    await store.saveToken("ops_private_storage");
    expect(await store.loadToken()).toBe("ops_private_storage");
    expect(
      await readFile(join(directory, "password-agent", "token"), "utf8"),
    ).toMatch(/^osr2\./);
    expect(
      await readFile(join(directory, "password-agent", "token"), "utf8"),
    ).not.toContain("ops_private_storage");
    expect(
      (await stat(join(directory, "password-agent", "token"))).mode & 0o777,
    ).toBe(0o600);
    expect((await stat(join(directory, "at-rest.key"))).mode & 0o777).toBe(
      0o600,
    );
    await expect(store.saveToken("ops_replacement")).rejects.toThrow();
    await store.saveSettings({
      name: "Work",
      vaults: [{ id: "id", name: "Automation" }],
    });
    expect(await store.loadSettings()).toMatchObject({ name: "Work" });
    expect(
      await readFile(join(directory, "password-agent", "settings"), "utf8"),
    ).not.toContain("Automation");
    await store.removeToken();
    expect(await store.hasToken()).toBe(false);
    await store.removeSettings();
    expect(await store.loadSettings()).toBeUndefined();
  });
  it("service.storage-fail-closed", async () => {
    if (process.platform !== "linux") return;
    const directory = await mkdtemp(join(tmpdir(), "os-password-agent-"));
    directories.push(directory);
    const store = createCredentialStore(directory);
    await store.saveToken("ops_private_storage");
    await writeFile(
      join(directory, "password-agent", "token"),
      "plaintext-token",
    );
    await expect(store.loadToken()).rejects.toThrow("could not be opened");
  });
});
