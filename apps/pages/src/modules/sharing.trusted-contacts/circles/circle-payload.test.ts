import { TRUSTED_CIRCLE_TYPE } from "@opensesame/app-core/lib/quorum/records.js";
import { createItem } from "@opensesame/vault-core";
import type { TypedItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  type Payload,
  circlePayload,
  folderNamed,
  foldersUnder,
} from "./circle-payload.js";
import { BANK_FOLDER, someItems } from "./circles.test-support.js";

const NESTED = {
  id: "folder-nested",
  name: "Banking/Joint",
  createdAt: "2026-10-01T00:00:00.000Z",
};
const OTHER = {
  id: "folder-other",
  name: "Bankingly",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function titles(document: Payload["document"]): string[] {
  const text = JSON.stringify(document);
  return [...text.matchAll(/"title":"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("a circle's payload", () => {
  it("is the vault's items as the vault's own CXF export writes them", () => {
    const payload = circlePayload(
      { items: someItems(), folders: [BANK_FOLDER] },
      { protects: "everything", folder: "" },
    );
    expect(titles(payload.document).sort()).toEqual(
      expect.arrayContaining(["Banking", "Router", "Savings"]),
    );
    expect(payload.skipped).toBe(0);
    expect(payload.withheld).toBe(0);
    expect(JSON.stringify(payload.document)).toContain("router-pass-1");
  });

  it("is one folder and what is under it, and nothing else", () => {
    const joint = {
      ...createItem("secret", "Joint account"),
      value: "joint-pass-3",
      folderId: NESTED.id,
    };
    const lookalike = {
      ...createItem("secret", "Not banking"),
      value: "other-pass-4",
      folderId: OTHER.id,
    };
    const payload = circlePayload(
      {
        items: [...someItems(), joint, lookalike],
        folders: [BANK_FOLDER, NESTED, OTHER],
      },
      { protects: "folder", folder: "banking" },
    );
    const text = JSON.stringify(payload.document);
    expect(text).toContain("savings-pass-2");
    expect(text).toContain("joint-pass-3");
    expect(text).not.toContain("router-pass-1");
    expect(text).not.toContain("other-pass-4");
  });

  it("leaves out a circle's own records: an owner key does not belong in a recovery file", () => {
    const record: TypedItem = {
      id: "circle-record",
      kind: "typed",
      name: "Family",
      folderId: null,
      favorite: false,
      notes: "",
      fields: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
      typeId: TRUSTED_CIRCLE_TYPE,
      values: { ownerKey: "owner-secret-key-material" },
    };
    const payload = circlePayload(
      { items: [...someItems(), record], folders: [] },
      { protects: "everything", folder: "" },
    );
    expect(JSON.stringify(payload.document)).not.toContain(
      "owner-secret-key-material",
    );
  });

  it("refuses a folder the vault does not have and a scope with nothing in it", () => {
    expect(() =>
      circlePayload(
        { items: someItems(), folders: [BANK_FOLDER] },
        { protects: "folder", folder: "Gone" },
      ),
    ).toThrow(/not in this vault/);
    expect(() =>
      circlePayload(
        { items: [], folders: [] },
        { protects: "everything", folder: "" },
      ),
    ).toThrow(/nothing here to protect/);
    expect(() =>
      circlePayload(
        { items: someItems().slice(0, 1), folders: [BANK_FOLDER] },
        { protects: "folder", folder: "Banking" },
      ),
    ).toThrow(/nothing here to protect/);
  });
});

describe("a folder named by a path", () => {
  it("is found however it is spelled, with its subfolders and not its lookalikes", () => {
    const folders = [BANK_FOLDER, NESTED, OTHER];
    expect(folderNamed(folders, "./banking/")?.id).toBe(BANK_FOLDER.id);
    expect(folderNamed(folders, "Bank")).toBeUndefined();
    expect(folderNamed(folders, "")).toBeUndefined();
    expect(folderNamed(folders, "BANKING")?.id).toBe(BANK_FOLDER.id);
    expect(foldersUnder(folders, "banking").map((f) => f.id)).toEqual([
      BANK_FOLDER.id,
      NESTED.id,
    ]);
    expect(foldersUnder(folders, "")).toEqual([]);
  });
});
