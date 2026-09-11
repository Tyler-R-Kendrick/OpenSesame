import { describe, expect, it } from "vitest";
import { pageTreeItemCount, pageTreeLeaves } from "../../lib/page-to-tree.js";
import { ACCESS_LABELS, ACCESS_VIEWS } from "../../lib/section-views.js";
import { accessPageTree } from "./page-tree.js";

describe("access page tree", () => {
  it("turns each Access tab into a subtree of that tab's page panels", () => {
    const tree = accessPageTree();
    expect(tree.map((node) => node.label)).toEqual(
      ACCESS_VIEWS.map((id) => ACCESS_LABELS[id]),
    );
    expect(tree.every((node) => node.branch)).toBe(true);
    const headings = (id: string) =>
      tree.find((node) => node.id === id)?.children.map((node) => node.label);
    expect(headings("grants")).toEqual([
      "Local application grants",
      "Identity shares",
    ]);
    expect(
      tree
        .find((node) => node.id === "grants")
        ?.children.every((node) => node.branch),
    ).toBe(true);
    expect(pageTreeLeaves(tree)).toEqual([]);
    expect(tree.every((node) => pageTreeItemCount(node) === 0)).toBe(true);
  });

  it("adds host and identity panels only when those planes are on the page", () => {
    const tree = accessPageTree({
      host: true,
      identity: true,
      shares: [{ id: "s1", label: "vault: Budget" }],
    });
    const headings = tree.flatMap((node) =>
      node.children.map((child) => child.label),
    );
    expect(headings).toEqual([
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
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "vault: Budget",
    ]);
    const grants = tree.find((node) => node.id === "grants");
    expect(grants && pageTreeItemCount(grants)).toBe(1);
  });
});
