/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  connectorResourceId,
  connectorResourceLabel,
  pendingConnectorDirectory,
  readConnectorDirectory,
  readDirectoryEndpoint,
  sealPendingConnectorDirectory,
  syncConnectorDirectory,
  writeDirectoryEndpoint,
} from "./connector-directory.js";
import { kvDelete } from "./kv.js";
import type { DirectoryConnection } from "./nango-directory.js";
import { mintVaultKey } from "./vault/crypto.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

const github: DirectoryConnection = {
  id: "1",
  connectionId: "octocat",
  integrationId: "github",
  provider: "github",
  displayName: "GitHub",
  endUser: "octo@example.com",
  createdAt: null,
  errors: 0,
};

const originalList = connectorDirectorySeams.listDirectory;

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [{ id: "github", provider: "github", displayName: "GitHub" }],
    connections: [github],
  }));
  connectorDirectorySeams.now = () => "2026-09-12T00:00:00.000Z";
});

afterEach(() => {
  clearPendingConnectorDirectory();
  connectorDirectorySeams.listDirectory = originalList;
  kvDelete("connector-directory.v1");
  lockAllTombs();
  vi.unstubAllGlobals();
});

async function openTomb(): Promise<string> {
  const tomb = `directory-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

describe("the endpoint, in plaintext", () => {
  it("round-trips a normalized endpoint and reads garbage as unset", async () => {
    await writeDirectoryEndpoint("https://api.nango.dev/");
    expect(readDirectoryEndpoint()).toBe("https://api.nango.dev");
    await writeDirectoryEndpoint("http://nango.internal");
    expect(readDirectoryEndpoint()).toBe("");
  });
});

describe("a sync", () => {
  it("seals the key and the list into an open tomb", async () => {
    const tomb = await openTomb();
    const record = await syncConnectorDirectory({
      endpoint: "https://api.nango.dev",
      key: " sk-env ",
      tomb,
    });
    expect(record.key).toBe("sk-env");
    expect(record.connections).toEqual([github]);
    expect(pendingConnectorDirectory()).toBeNull();
    expect(readDirectoryEndpoint()).toBe("https://api.nango.dev");
    const stored = await readConnectorDirectory(tomb);
    expect(stored?.syncedAt).toBe("2026-09-12T00:00:00.000Z");
    expect(stored?.connections.map((row) => row.connectionId)).toEqual([
      "octocat",
    ]);
  });

  it("waits in memory before a vault exists, then seals on the first unlock", async () => {
    await syncConnectorDirectory({
      endpoint: "http://localhost:3003",
      key: "",
      tomb: null,
    });
    expect(pendingConnectorDirectory()?.endpoint).toBe("http://localhost:3003");
    const tomb = await openTomb();
    expect(await sealPendingConnectorDirectory(tomb)).toBe(true);
    expect(pendingConnectorDirectory()).toBeNull();
    expect((await readConnectorDirectory(tomb))?.connections).toHaveLength(1);
    expect(await sealPendingConnectorDirectory(tomb)).toBe(false);
  });

  it("gives a guest session the list but keeps waiting for a vault that lasts", async () => {
    await syncConnectorDirectory({
      endpoint: "https://api.nango.dev",
      key: "sk-env",
      tomb: null,
    });
    const guest = await openTomb();
    expect(
      await sealPendingConnectorDirectory(guest, { ephemeral: true }),
    ).toBe(true);
    expect((await readConnectorDirectory(guest))?.key).toBe("sk-env");
    expect(pendingConnectorDirectory()?.endpoint).toBe("https://api.nango.dev");
    const personal = await openTomb();
    expect(await sealPendingConnectorDirectory(personal)).toBe(true);
    expect(pendingConnectorDirectory()).toBeNull();
    expect((await readConnectorDirectory(personal))?.connections).toHaveLength(
      1,
    );
  });

  it("keeps nothing sealed when the tomb it was told about is locked", async () => {
    await syncConnectorDirectory({
      endpoint: "https://api.nango.dev",
      key: "k",
      tomb: "never-opened",
    });
    expect(pendingConnectorDirectory()).not.toBeNull();
  });

  it("refuses an endpoint this page may not call before reading anything", async () => {
    await expect(
      syncConnectorDirectory({
        endpoint: "http://nango.internal",
        key: "k",
        tomb: null,
      }),
    ).rejects.toThrow(/https/);
    expect(connectorDirectorySeams.listDirectory).not.toHaveBeenCalled();
  });

  it("reads a tomb with no record as none, and a locked tomb as locked", async () => {
    const tomb = await openTomb();
    expect(await readConnectorDirectory(tomb)).toBeNull();
    lockAllTombs();
    await expect(readConnectorDirectory(tomb)).rejects.toMatchObject({
      code: "locked",
    });
  });
});

describe("naming for the PAM plane", () => {
  it("names a connection by integration and id, and by number when too long", () => {
    expect(connectorResourceId(github)).toBe("nango:github/octocat");
    expect(connectorResourceLabel(github)).toBe("GitHub · octo@example.com");
    const long = { ...github, connectionId: "c".repeat(140) };
    expect(connectorResourceId(long)).toMatch(/^nango:github#[0-9a-f]{8}$/);
    // The digest is over the pair, so Nango's numeric id plays no part — an
    // older server sends none — and two long connections never share one.
    expect(connectorResourceId({ ...long, id: "" })).toBe(
      connectorResourceId(long),
    );
    expect(
      connectorResourceId({ ...long, connectionId: "d".repeat(140) }),
    ).not.toBe(connectorResourceId(long));
    expect(
      connectorResourceId({ ...long, integrationId: "i".repeat(128) }).length,
    ).toBeLessThanOrEqual(128);
  });
});
