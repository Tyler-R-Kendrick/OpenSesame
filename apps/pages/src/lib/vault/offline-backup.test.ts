import { describe, expect, it, beforeEach } from "vitest";
import {
  buildOfflineBackup,
  cacheCiphertextSnapshot,
  clearOfflineMutations,
  enqueueOfflineMutation,
  listOfflineMutations,
  loadCachedCiphertextSnapshot,
  parseOfflineBackup,
  refuseDeploymentSealWrap,
  serializeOfflineBackup,
} from "./offline-backup.js";
import type { SealedBlob, VaultHeader } from "./crypto.js";

const header: VaultHeader = {
  v: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
  kdf: {
    alg: "PBKDF2-SHA256",
    saltB64: "AQIDBAUGBwgJCgsMDQ4PEA==",
    iterations: 600_000,
  },
  wrap: { ivB64: "AAAAAAAAAAAA", ctB64: "Y2lwaGVydGV4dA==" },
};

const body: SealedBlob = {
  ivB64: "BBBBBBBBBBBB",
  ctB64: "c2VhbGVkLWJvZHk=",
};

describe("offline-backup", () => {
  beforeEach(() => {
    clearOfflineMutations();
  });

  it("round-trips a ciphertext-only envelope", () => {
    const envelope = buildOfflineBackup({
      projectId: "project:personal",
      header,
      body,
      syncBlobs: [
        { id: "project:personal:note", epoch: 2, ciphertextB64: "AAEC" },
      ],
    });
    expect(envelope.deploymentSealUsed).toBe(false);
    const json = serializeOfflineBackup(envelope);
    expect(json).not.toContain('"plaintext"');
    expect(json).not.toContain("OPENSESAME_CONNECTION_KEY");
    const parsed = parseOfflineBackup(json);
    expect(parsed.projectId).toBe("project:personal");
    expect(parsed.vault.body.ctB64).toBe(body.ctB64);
    expect(parsed.syncBlobs).toHaveLength(1);
  });

  it("refuses deployment seal as wrap key", () => {
    expect(() => refuseDeploymentSealWrap("OPENSESAME_CONNECTION_KEY")).toThrow(
      /deployment seal/,
    );
    expect(() => refuseDeploymentSealWrap("device-vrk")).not.toThrow();
  });

  it("caches ciphertext for offline reads and queues mutations", () => {
    const envelope = buildOfflineBackup({
      projectId: "p1",
      header,
      body,
    });
    cacheCiphertextSnapshot(envelope);
    const cached = loadCachedCiphertextSnapshot("p1");
    expect(cached?.vault.body.ctB64).toBe(body.ctB64);

    const queued = enqueueOfflineMutation({
      kind: "push_sync_blobs",
      projectId: "p1",
      blobs: [{ id: "a", epoch: 1, ciphertextB64: "AQ==" }],
    });
    expect(listOfflineMutations().some((m) => m.id === queued.id)).toBe(true);
  });

  it("rejects backups that claim deployment seal", () => {
    const bad = JSON.stringify({
      format: "opensesame-offline-backup",
      v: 1,
      projectId: null,
      exportedAt: "2026-08-17T00:00:00.000Z",
      vault: { header, body },
      syncBlobs: [],
      deploymentSealUsed: true,
    });
    expect(() => parseOfflineBackup(bad)).toThrow(/deployment seal/);
  });
});
