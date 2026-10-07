import {
  importVaultKey,
  openJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { makeOpfs } from "../duress/wipe/fake-opfs.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

it("keeps a creator's actual VFS authority when a separate tab first unlocks the same real root", async () => {
  const root = makeOpfs();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
    locks: webLocksDouble(),
  });
  const atRestKey = crypto.getRandomValues(new Uint8Array(32));
  configureHost(
    createTestHost({
      atRestKeys: { loadSync: () => atRestKey, load: async () => atRestKey },
    }),
  );
  const password = "genuine newly created shared persistent owner";
  const firstFiles = await import("../vfs.js");
  const { VaultStore } = await import("./store.js");
  const creator = new VaultStore();
  await creator.create(password);
  const originalHeader = creator.getSnapshot().header;
  if (!originalHeader?.protection)
    throw new Error("Expected first authenticated owner header");
  const raw = await unwrapRawVaultKeyFromPassword(originalHeader, password);
  try {
    const actualOriginalKey = await importVaultKey(raw);
    await firstFiles.writeFile(
      "personal",
      "proof/application.json",
      new TextEncoder().encode("current owner registration"),
    );
    // Independent module registries give both tabs their own real KV and admitted-key maps.
    vi.resetModules();
    const peerKv = await import("../kv.js");
    const peerFiles = await import("../vfs.js");
    await peerKv.kvHydrate(
      ["header", "body", "index", "migrated.v1", "seal-bound.v1"].map((path) =>
        peerFiles.tombFileKey("personal", path),
      ),
    );
    const { VaultStore: PeerStore } = await import("./store.js");
    const peer = new PeerStore();
    await peer.unlock(password);
    try {
      const currentHeader = peer.getSnapshot().header;
      if (!currentHeader?.protection)
        throw new Error("Expected authenticated peer manifest");
      const { verifyManifestAuth } = await import(
        "./protection/manifest-auth.js"
      );
      await verifyManifestAuth(raw, originalHeader.protection);
      await verifyManifestAuth(raw, currentHeader.protection);
      expect(currentHeader.protection.vaultId).toBe(
        originalHeader.protection.vaultId,
      );
      expect(currentHeader.protection.rootKeyId).toBe(
        originalHeader.protection.rootKeyId,
      );
      const currentBody = peerFiles.readSealedFile("personal", "body");
      if (!currentBody) throw new Error("Expected genuine sealed body");
      await openJson(
        actualOriginalKey,
        currentBody,
        vaultSealBinding("personal", "body"),
      );
      await expect(
        firstFiles.writeFile(
          "personal",
          "proof/application.json",
          new TextEncoder().encode("accepted current owner edit"),
        ),
      ).resolves.toBeUndefined();
      expect(
        new TextDecoder().decode(
          await firstFiles.readFile("personal", "proof/application.json"),
        ),
      ).toBe("accepted current owner edit");
    } finally {
      peer.lock();
    }
  } finally {
    raw.fill(0);
    creator.lock();
  }
});
