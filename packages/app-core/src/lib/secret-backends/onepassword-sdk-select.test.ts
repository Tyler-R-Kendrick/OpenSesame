import { describe, expect, it } from "vitest";
import {
  onePasswordSdkSelect,
  onePasswordSdkSummaries,
} from "./onepassword-sdk-codec.js";
import { SecretBackendError } from "./types.js";

const vault = "fixture-vault";
const itemId = "fixture-item";
function overview(id = itemId, title = "Fixture login", category = "Login") {
  return {
    id,
    title,
    category,
    vaultId: vault,
    websites: [],
    tags: [],
    createdAt: "2026-10-15T04:05:06Z",
    updatedAt: "2026-10-15T04:05:06Z",
    state: "active",
  };
}
function expectCode(operation: () => void, code: SecretBackendError["code"]) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretBackendError);
    if (error instanceof SecretBackendError) expect(error.code).toBe(code);
    return;
  }
  throw new Error("Expected a sanitized secret-backend failure.");
}

describe("native 1Password overview selection", () => {
  it("lists only active supported native categories", () => {
    const rows = [
      overview(),
      overview("note", "Note", "SecureNote"),
      overview("secret", "Secret", "ApiCredentials"),
      { ...overview("old"), state: "archived" },
      overview("document", "Document", "Document"),
    ];
    expect(onePasswordSdkSummaries(rows, vault)).toEqual([
      { id: itemId, name: "Fixture login", kind: "login" },
      { id: "note", name: "Note", kind: "note" },
      { id: "secret", name: "Secret", kind: "secret" },
    ]);
  });

  it("accepts an empty list and resolves exact IDs before titles", () => {
    expect(onePasswordSdkSummaries([], vault)).toEqual([]);
    expectCode(() => onePasswordSdkSummaries([], ""), "response");
    expect(
      onePasswordSdkSelect(
        [overview(), overview("other", itemId)],
        vault,
        itemId,
      ),
    ).toBe(itemId);
    expect(onePasswordSdkSelect([overview()], vault, "Fixture login")).toBe(
      itemId,
    );
  });

  it("requires an ID for duplicate active titles", () => {
    const rows = [overview(), overview("another")];
    expectCode(
      () => onePasswordSdkSelect(rows, vault, "Fixture login"),
      "ambiguous",
    );
    expect(onePasswordSdkSelect(rows, vault, itemId)).toBe(itemId);
  });

  it("ignores an archived duplicate title and never falls through an archived ID", () => {
    const rows = [
      overview(),
      { ...overview("old"), state: "archived" },
      overview("other", "old"),
    ];
    expect(onePasswordSdkSelect(rows, vault, "Fixture login")).toBe(itemId);
    expectCode(() => onePasswordSdkSelect(rows, vault, "old"), "not-found");
  });

  it("does not reinterpret an unsupported ID as another item's title", () => {
    const rows = [
      overview("doc", "Document", "Document"),
      overview("login", "doc"),
    ];
    expectCode(() => onePasswordSdkSelect(rows, vault, "doc"), "unsupported");
  });

  it("checks scope and duplicate IDs even on archived or unsupported entries", () => {
    for (const row of [
      { ...overview("old"), state: "archived" },
      overview("doc", "Document", "Document"),
    ]) {
      expectCode(
        () => onePasswordSdkSummaries([{ ...row, vaultId: "foreign" }], vault),
        "response",
      );
      expectCode(() => onePasswordSdkSummaries([row, row], vault), "ambiguous");
    }
  });

  it.each(["ARCHIVED", "ACTIVE", "deleted", ""])(
    "rejects unknown overview state %s",
    (state) => {
      expectCode(
        () => onePasswordSdkSummaries([{ ...overview(), state }], vault),
        "response",
      );
    },
  );

  it("rejects absent selections, invalid selectors and malformed lists", () => {
    expectCode(() => onePasswordSdkSelect([], vault, "missing"), "not-found");
    expectCode(() => onePasswordSdkSelect([overview()], vault, ""), "response");
    expectCode(
      () => onePasswordSdkSummaries({ success: true, data: [] }, vault),
      "response",
    );
    expectCode(
      () =>
        onePasswordSdkSummaries(
          [
            { ...overview(), websites: [] },
            { ...overview("bad"), title: 42 },
          ],
          vault,
        ),
      "response",
    );
  });
});
