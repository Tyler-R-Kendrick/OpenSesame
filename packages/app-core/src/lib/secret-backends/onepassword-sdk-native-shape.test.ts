import { expect, it } from "vitest";
import { readOnePasswordSdkItem } from "./onepassword-sdk-codec.js";

// Shape emitted by pinned official core 0.5.0 after real encrypted ItemsCreate,
// independently verified through the production worker (owned browser attempt 43).
const item = {
  id: "owned-note",
  vaultId: "owned-vault",
  title: "Owned SDK note",
  category: "SecureNote",
  fields: [],
  sections: [],
  notes: "Independent native note",
  tags: [],
  websites: [],
  version: 1,
  files: [],
  document: null,
  createdAt: "2026-10-16T19:50:41Z",
  updatedAt: "2026-10-16T19:50:41Z",
};
it("reads official native null document and preserves the full item for update", () => {
  const result = readOnePasswordSdkItem(item, item.vaultId, item.id);
  expect(result.normalized).toMatchObject({
    id: item.id,
    kind: "note",
    notes: item.notes,
  });
  expect(result.raw).toBe(item);
  expect(result.data.document).toBeNull();
});
it.each([false, "invalid", { id: "file", name: "file", size: -1 }])(
  "continues rejecting malformed non-null document metadata %j",
  (document) => {
    expect(() =>
      readOnePasswordSdkItem({ ...item, document }, item.vaultId, item.id),
    ).toThrow();
  },
);

it("reads official native null built-in section IDs without losing field metadata", () => {
  const input = {
    ...item,
    category: "Login",
    fields: [
      {
        id: "username",
        title: "username",
        sectionId: null,
        fieldType: "Text",
        value: "owned user",
        details: null,
      },
      {
        id: "password",
        title: "password",
        sectionId: null,
        fieldType: "Concealed",
        value: "owned secret",
        details: null,
      },
    ],
  };
  const result = readOnePasswordSdkItem(input, item.vaultId, item.id);
  expect(result.normalized).toMatchObject({
    kind: "login",
    username: "owned user",
    secret: "owned secret",
  });
  expect(result.raw).toBe(input);
  expect(result.fields.secret?.sectionId).toBeNull();
});
it.each([false, 1, {}])(
  "rejects malformed non-null section ID %j",
  (sectionId) => {
    expect(() =>
      readOnePasswordSdkItem(
        {
          ...item,
          fields: [
            {
              id: "username",
              title: "username",
              sectionId,
              fieldType: "Text",
              value: "owned user",
            },
          ],
        },
        item.vaultId,
        item.id,
      ),
    ).toThrow();
  },
);
