import { memoryObjectStore, sealFile } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { concealedValue, shareText } from "./vault-section-model.js";

describe("a file secret", () => {
  it("does not offer the part key as something to copy or share", async () => {
    const manifest = await sealFile({
      name: "lease.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("CANARY-PLAINTEXT-BYTES"),
      stores: [memoryObjectStore()],
    });
    const item = {
      id: "itm_file",
      kind: "typed" as const,
      typeId: "file",
      name: "Lease",
      folderId: null,
      favorite: false,
      notes: "",
      fields: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      values: { bytes: manifest },
    };
    expect(manifest.includes("CANARY-PLAINTEXT-BYTES")).toBe(false);
    expect(concealedValue(item)).toBeNull();
    expect(shareText(item)).toBeNull();
  });
});
