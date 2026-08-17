import { describe, expect, it } from "vitest";
import {
  SyncBlobsPushRequestSchema,
  SyncBlobsSnapshotResponseSchema,
  isCiphertextOnlySyncPayload,
} from "../sync_blobs.js";

describe("sync_blobs contracts", () => {
  it("accepts opaque ciphertext blobs", () => {
    const ok = SyncBlobsPushRequestSchema.parse({
      blobs: [{ id: "project:p1:note", epoch: 3, ciphertext: [1, 2, 3] }],
    });
    expect(ok.blobs).toHaveLength(1);
    expect(isCiphertextOnlySyncPayload(ok)).toBe(true);
  });

  it("rejects plaintext and deployment-seal fields", () => {
    expect(
      SyncBlobsPushRequestSchema.safeParse({
        blobs: [],
        plaintext: "leak",
      }).success,
    ).toBe(false);
    expect(
      SyncBlobsPushRequestSchema.safeParse({
        blobs: [
          {
            id: "a",
            epoch: 1,
            ciphertext: [1],
            password: "x",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SyncBlobsPushRequestSchema.safeParse({
        blobs: [{ id: "a", epoch: 1, ciphertext: [1] }],
        deployment_seal: "nope",
      }).success,
    ).toBe(false);
  });

  it("parses snapshot responses that declare no wrap key", () => {
    const res = SyncBlobsSnapshotResponseSchema.parse({
      format: "opensesame-sync-blobs-snapshot",
      version: 1,
      project_id: "p1",
      blobs: [{ id: "a", epoch: 1, ciphertext: [9] }],
      plaintext: null,
      note: "ciphertext only",
      wrap_key: null,
      deployment_seal_used: false,
    });
    expect(res.deployment_seal_used).toBe(false);
    expect(res.wrap_key).toBeNull();
  });
});
