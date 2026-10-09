import type { VaultItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { liveItemPickLabels } from "./item-pick-label.js";

const T0 = "2026-01-01T00:00:00.000Z";

function item(id: string, name: string, typeId: string): VaultItem {
  return {
    id,
    name,
    kind: "typed",
    typeId,
    values: {},
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
}

describe("liveItemPickLabels", () => {
  it("adds the type when names collide", () => {
    const labels = liveItemPickLabels([
      item("a", "GitHub", "account"),
      item("b", "GitHub", "secret"),
    ]);
    expect(labels.get("a")).toMatch(/^GitHub · /);
    expect(labels.get("b")).toMatch(/^GitHub · /);
    expect(labels.get("a")).not.toBe(labels.get("b"));
  });

  it("keeps a single name alone", () => {
    const labels = liveItemPickLabels([item("a", "Solo", "note")]);
    expect(labels.get("a")).toBe("Solo");
  });
});
