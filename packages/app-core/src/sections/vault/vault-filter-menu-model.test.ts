import { createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { buildRoads } from "./vault-filter-menu-model.js";

describe("the vault filter roads for received items", () => {
  it("names shared and owned views only when something was shared", () => {
    const shared = createItem("note", "Shared note");
    shared.id = "itm_shared";
    const own = createItem("note", "Own note");
    own.id = "itm_own";
    const marks = new Map([
      ["itm_shared", { incoming: [{ id: "local_alice", name: "Alice" }] }],
    ]);

    const roads = buildRoads([shared, own], [], ["note"], "all", null, marks);
    expect(roads.find((road) => road.key === "shared")).toMatchObject({
      label: "Shared with me",
      count: 1,
      to: "/vault?f=shared",
    });
    expect(roads.find((road) => road.key === "owned")).toMatchObject({
      label: "Owned by me",
      count: 1,
      to: "/vault?f=owned",
    });

    expect(
      buildRoads([shared, own], [], ["note"], "all", null).some(
        (road) => road.key === "shared",
      ),
    ).toBe(false);
  });
});
