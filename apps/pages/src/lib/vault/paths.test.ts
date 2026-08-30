import { describe, expect, it } from "vitest";
import { createItem } from "./model.js";
import { itemPath, tombPath } from "./paths.js";

describe("vault tree paths", () => {
  it("maps root and folder items into the tomb path space", () => {
    const root = createItem("login");
    root.name = "Mail";
    const nested = createItem("secret");
    nested.name = "Deploy token";
    nested.folderId = "work";
    const folders = [{ id: "work", name: "Work", createdAt: "2026-08-29" }];

    expect(itemPath(root, folders)).toBe("Mail");
    expect(itemPath(nested, folders)).toBe("Work/Deploy token");
    expect(tombPath("personal", itemPath(nested, folders))).toBe(
      "personal:/Work/Deploy token",
    );
  });

  it("keeps item slashes inside one visible tree segment", () => {
    const item = createItem("note");
    item.name = "prod/us-east";
    expect(itemPath(item, [])).toBe("prod／us-east");
  });
});
