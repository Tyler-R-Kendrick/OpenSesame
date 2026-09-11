import { describe, expect, it } from "vitest";
import { pageTreeLeaves } from "../../lib/page-to-tree.js";
import { ACCESS_LABELS, ACCESS_VIEWS } from "../../lib/section-views.js";
import { accessPageTree } from "./page-tree.js";

describe("access page tree", () => {
  it("turns each Access tab into a subtree of that tab's page panels", () => {
    const tree = accessPageTree();
    expect(tree.map((node) => node.label)).toEqual(
      ACCESS_VIEWS.map((id) => ACCESS_LABELS[id]),
    );
    expect(tree.every((node) => node.branch)).toBe(true);
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "Local application grants",
      "Identity shares",
      "Local requests",
      "Local sessions & grants",
      "Local application policies",
    ]);
  });

  it("adds host and identity panels only when those planes are on the page", () => {
    const tree = accessPageTree({ host: true, identity: true });
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "Local application grants",
      "Identity shares",
      "Grants",
      "Local requests",
      "Requests",
      "Local sessions & grants",
      "Host task sessions",
      "Sites",
      "Local application policies",
      "Policies",
    ]);
  });
});
