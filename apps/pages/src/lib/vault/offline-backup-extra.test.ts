import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvSet } from "../kv.js";
import { createVault, sealJson } from "./crypto.js";
import {
  type OfflineBackupEnvelope,
  assertCiphertextOnlyBackupJson,
  buildOfflineBackup,
  cacheCiphertextSnapshot,
  clearOfflineMutations,
  dequeueOfflineMutation,
  enqueueOfflineMutation,
  listOfflineMutations,
  loadCachedCiphertextSnapshot,
  parseOfflineBackup,
  refuseDeploymentSealWrap,
  serializeOfflineBackup,
} from "./offline-backup.js";

const PASSWORD = "correct horse battery staple";

async function realEnvelope(): Promise<OfflineBackupEnvelope> {
  const { header, vaultKey } = await createVault(PASSWORD);
  const body = await sealJson(vaultKey, { v: 1, items: [], folders: [] });
  return buildOfflineBackup({ header, body });
}

beforeEach(() => {
  clearOfflineMutations();
});

describe("ciphertext-only guards", () => {
  it("rejects backup JSON carrying plaintext-shaped fields", () => {
    expect(() => assertCiphertextOnlyBackupJson('{"password": "x"}')).toThrow(
      /plaintext or deployment-seal/,
    );
    expect(() => assertCiphertextOnlyBackupJson('{"token":"x"}')).toThrow(
      /plaintext or deployment-seal/,
    );
    expect(() =>
      assertCiphertextOnlyBackupJson('{"ct":"OPENSESAME_CONNECTION_KEY"}'),
    ).toThrow(/plaintext or deployment-seal/);
    expect(() =>
      assertCiphertextOnlyBackupJson('{"ctB64":"AAAA"}'),
    ).not.toThrow();
  });

  it("refuses wrap labels that smell like the deployment seal", () => {
    expect(() => refuseDeploymentSealWrap("device-vault-unlock")).not.toThrow();
    for (const label of [
      "OPENSESAME_CONNECTION_KEY",
      "deployment_seal",
      "broker_seal",
      "opensesame_connection",
    ]) {
      expect(() => refuseDeploymentSealWrap(label)).toThrow(
        /deployment seal key/,
      );
    }
  });
});

describe("buildOfflineBackup", () => {
  it("requires a sealed body, not just a header", async () => {
    const { header } = await createVault(PASSWORD);
    expect(() =>
      buildOfflineBackup({
        header,
        body: { ivB64: "", ctB64: "" },
      }),
    ).toThrow(/sealed vault header and body/);
  });

  it("defaults project and timestamp, and never uses the deployment seal", async () => {
    const envelope = await realEnvelope();
    expect(envelope.projectId).toBeNull();
    expect(envelope.deploymentSealUsed).toBe(false);
    expect(Date.parse(envelope.exportedAt)).not.toBeNaN();
  });
});

describe("serializeOfflineBackup", () => {
  it("refuses an envelope that claims a deployment seal", async () => {
    const envelope = await realEnvelope();
    const tainted: OfflineBackupEnvelope = overlapCast({
      ...envelope,
      deploymentSealUsed: true,
    });
    expect(() => serializeOfflineBackup(tainted)).toThrow(/deployment seal/);
  });
});

describe("parseOfflineBackup", () => {
  it("rejects non-JSON, non-objects, and foreign formats", () => {
    expect(() => parseOfflineBackup("{{{{")).toThrow(/not valid JSON/);
    expect(() => parseOfflineBackup("[1,2]")).toThrow(/not an OpenSesame/);
    expect(() => parseOfflineBackup("42")).toThrow(/not an OpenSesame/);
    expect(() => parseOfflineBackup('{"format":"other","v":1}')).toThrow(
      /not an OpenSesame/,
    );
  });

  it("rejects a backup that claims a deployment seal wrap", async () => {
    const envelope = await realEnvelope();
    const json = serializeOfflineBackup(envelope).replace(
      '"deploymentSealUsed": false',
      '"deploymentSealUsed": "yes"',
    );
    expect(() => parseOfflineBackup(json)).toThrow(/deployment seal/);
  });

  it("rejects backups without sealed vault ciphertext", async () => {
    const envelope = await realEnvelope();
    const broken = {
      ...envelope,
      vault: { header: envelope.vault.header },
    };
    expect(() => parseOfflineBackup(JSON.stringify(broken))).toThrow(
      /missing sealed vault ciphertext/,
    );
  });

  it("rejects malformed sync blobs", async () => {
    const envelope = await realEnvelope();
    const withBad = {
      ...envelope,
      syncBlobs: [{ id: "x", epoch: "one", ciphertextB64: "AA==" }],
    };
    expect(() => parseOfflineBackup(JSON.stringify(withBad))).toThrow(
      /malformed sync blob/,
    );
    const withEmpty = {
      ...envelope,
      syncBlobs: [{ id: "x", epoch: 1, ciphertextB64: "" }],
    };
    expect(() => parseOfflineBackup(JSON.stringify(withEmpty))).toThrow(
      /malformed sync blob/,
    );
  });

  it("normalizes missing project and timestamp fields", async () => {
    const envelope = await realEnvelope();
    const roundTripped = parseOfflineBackup(serializeOfflineBackup(envelope));
    expect(roundTripped.projectId).toBeNull();
    expect(roundTripped.vault.header.createdAt).toBe(
      envelope.vault.header.createdAt,
    );

    const minimal = overlapCast(JSON.parse(serializeOfflineBackup(envelope)));
    const { projectId: _p, exportedAt: _e, ...rest } = minimal;
    const parsed = parseOfflineBackup(JSON.stringify(rest));
    expect(parsed.projectId).toBeNull();
    expect(Date.parse(parsed.exportedAt)).not.toBeNaN();
  });
});

describe("cached ciphertext snapshot", () => {
  it("round-trips an envelope through the KV cache", async () => {
    const envelope = await realEnvelope();
    cacheCiphertextSnapshot(envelope);
    expect(loadCachedCiphertextSnapshot()?.vault.header.createdAt).toBe(
      envelope.vault.header.createdAt,
    );
  });

  it("returns null when nothing is cached or the cache is unreadable", () => {
    expect(loadCachedCiphertextSnapshot("never-seen")).toBeNull();
    kvSet("vault.offline-ciphertext.v1:_default", "not json at all");
    expect(loadCachedCiphertextSnapshot()).toBeNull();
    kvDelete("vault.offline-ciphertext.v1:_default");
  });
});

describe("offline mutation queue", () => {
  it("queues a ciphertext cache replacement with its serialized envelope", async () => {
    const envelope = await realEnvelope();
    const item = enqueueOfflineMutation({
      kind: "replace_ciphertext_cache",
      projectId: "team",
      envelope,
    });
    expect(item.kind).toBe("replace_ciphertext_cache");
    const listed = listOfflineMutations();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.projectId).toBe("team");
  });

  it("refuses to queue an empty ciphertext blob", () => {
    expect(() =>
      enqueueOfflineMutation({
        kind: "push_sync_blobs",
        blobs: [{ id: "x", epoch: 1, ciphertextB64: "" }],
      }),
    ).toThrow(/empty ciphertext/);
    expect(listOfflineMutations()).toHaveLength(0);
  });

  it("dequeues by id and leaves the rest", () => {
    const a = enqueueOfflineMutation({
      kind: "push_sync_blobs",
      blobs: [{ id: "a", epoch: 1, ciphertextB64: btoa("a") }],
    });
    enqueueOfflineMutation({
      kind: "push_sync_blobs",
      blobs: [{ id: "b", epoch: 1, ciphertextB64: btoa("b") }],
    });
    dequeueOfflineMutation(a.id);
    const remaining = listOfflineMutations();
    expect(remaining).toHaveLength(1);
  });

  it("recovers an empty queue from corrupted storage", () => {
    kvSet("vault.offline-mutations.v1", "{not json");
    expect(listOfflineMutations()).toEqual([]);
    kvSet("vault.offline-mutations.v1", '{"not":"an array"}');
    expect(listOfflineMutations()).toEqual([]);
    kvDelete("vault.offline-mutations.v1");
  });
});
