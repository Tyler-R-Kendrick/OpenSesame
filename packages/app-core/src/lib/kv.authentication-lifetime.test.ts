import { overlapCast } from "@opensesame/os-domain";
import {
  mintVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import {
  kvFileName,
  kvForgetFiles,
  kvGet,
  kvRefresh,
  kvSetDurable,
} from "./kv.js";
import { installFileBackedVfs } from "./secret-fs/install.js";
import { makeMemorySecretFiles } from "./secret-fs/memory.js";
import { captureAuthenticationStorage } from "./vault/authentication-storage.js";
import { vfsSeams as physical } from "./vfs-seams-state.js";
import { vfsSeams } from "./vfs-seams.js";

async function physicalCiphertext() {
  const originalHost = host();
  const root = makeOpfs();
  const installed = createTestHost({
    originFiles: async () => overlapCast(root),
  });
  configureHost(installed);
  const tomb = `test-${crypto.randomUUID()}`;
  const key = `tomb/${tomb}/body`;
  const minted = await mintVaultKey();
  minted.rawVaultKey.fill(0);
  const value = { v: 1, items: [], folders: [], rev: 1 };
  const sealed = await sealJson(
    minted.vaultKey,
    value,
    vaultSealBinding(tomb, "body"),
  );
  await kvSetDurable(key, JSON.stringify(sealed));
  await kvSetDurable(`tomb/${tomb}/header`, '{"bodyRev":1}');
  return {
    root,
    installed,
    tomb,
    key,
    vaultKey: minted.vaultKey,
    value,
    finish() {
      kvForgetFiles(
        new Set([kvFileName(key), kvFileName(`tomb/${tomb}/header`)]),
      );
      configureHost(originalHost);
    },
  };
}

/** Exercise the old public call too: extra JS arguments must never count as an auth verdict. */
function refreshOriginal(key: string, check: () => void): Promise<void> {
  const refresh: (
    key: string,
    maxBytes: number,
    original: () => void,
  ) => Promise<void> = kvRefresh;
  return refresh(key, 256 * 1024 * 1024, check);
}

it("refreshes genuine vault ciphertext through the actual device at-rest seal", async () => {
  const fixture = await physicalCiphertext();
  try {
    expect(physical).toBe(vfsSeams);
    expect(fixture.root.files.get(kvFileName(fixture.key))).not.toContain(
      '"items"',
    );
    await refreshOriginal(fixture.key, () => {
      if (host() !== fixture.installed)
        throw new Error("Original host changed.");
    });
    const body = kvGet(fixture.key);
    if (!body) throw new Error("The actual refreshed ciphertext is missing.");
    await expect(
      openJson(
        fixture.vaultKey,
        JSON.parse(body),
        vaultSealBinding(fixture.tomb, "body"),
      ),
    ).resolves.toEqual(fixture.value);
    const storage = captureAuthenticationStorage(fixture.tomb, () => {
      if (host() !== fixture.installed)
        throw new Error("Original host changed.");
    });
    const actual = await storage.read();
    expect(actual.header).toBe('{"bodyRev":1}');
    expect(actual.body).toBe(body);
    await expect(storage.revalidate(actual)).resolves.toBeUndefined();
  } finally {
    fixture.finish();
  }
});

it("preserves actual foreign-bound ciphertext for independent crypto refusal", async () => {
  const fixture = await physicalCiphertext();
  try {
    const foreign = await sealJson(
      fixture.vaultKey,
      fixture.value,
      vaultSealBinding("foreign", "body"),
    );
    await kvSetDurable(fixture.key, JSON.stringify(foreign));
    await refreshOriginal(fixture.key, () => {
      if (host() !== fixture.installed)
        throw new Error("Original host changed.");
    });
    const body = kvGet(fixture.key);
    if (!body) throw new Error("The actual foreign ciphertext is missing.");
    await expect(
      openJson(
        fixture.vaultKey,
        JSON.parse(body),
        vaultSealBinding(fixture.tomb, "body"),
      ),
    ).rejects.toThrow();
    const restore = await installFileBackedVfs(makeMemorySecretFiles());
    try {
      const storage = captureAuthenticationStorage(fixture.tomb, () => {
        if (host() !== fixture.installed)
          throw new Error("Original host changed.");
      });
      await expect(storage.read()).rejects.toThrow(
        "Fresh ciphertext reads are unavailable",
      );
    } finally {
      restore();
    }
  } finally {
    fixture.finish();
  }
});

it("refuses a held physical text completion after the actual original host is replaced", async () => {
  const fixture = await physicalCiphertext();
  let release = () => {};
  let started = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const originalFile = fixture.root.getFileHandle.bind(fixture.root);
  fixture.root.getFileHandle = async (name, options) => {
    const handle = await originalFile(name, options);
    if (name !== kvFileName(fixture.key)) return handle;
    return {
      ...handle,
      async getFile() {
        const file = await handle.getFile();
        return {
          ...file,
          async text() {
            const actual = await file.text();
            started();
            await held;
            return actual;
          },
        };
      },
    };
  };
  try {
    const pending = refreshOriginal(fixture.key, () => {
      if (host() !== fixture.installed)
        throw new Error("Original host changed.");
    });
    const refused = expect(pending).rejects.toThrow("Original host changed");
    await entered;
    configureHost(
      createTestHost({ originFiles: async () => overlapCast(makeOpfs()) }),
    );
    release();
    await refused;
    expect(kvGet(fixture.key)).toBeNull();
  } finally {
    release();
    fixture.finish();
  }
});

it("refuses an uninitialized transport and never upgrades its earlier capture", async () => {
  const previousHost = host();
  vi.resetModules();
  const freshHost = await import("../host.js");
  try {
    const freshTest = await import("../test-host.js");
    freshHost.configureHost(freshTest.createTestHost());
    const leaf = await import("./vfs-seams-state.js");
    const auth = await import("./vault/authentication-storage.js");
    const earlier = auth.captureAuthenticationStorage("cold-start", () => {});
    await expect(earlier.read()).rejects.toThrow(
      "Fresh ciphertext reads are unavailable",
    );
    const initialized = await import("./vfs-seams.js");
    expect(initialized.vfsSeams).toBe(leaf.vfsSeams);
    await expect(earlier.read()).rejects.toThrow("storage context changed");
    const current = auth.captureAuthenticationStorage("cold-start", () => {});
    await expect(current.read()).resolves.toEqual({
      tomb: "cold-start",
      header: null,
      body: null,
    });
  } finally {
    freshHost.configureHost(previousHost);
    vi.resetModules();
  }
});
