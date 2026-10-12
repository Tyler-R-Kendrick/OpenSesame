import { describe, expect, it } from "vitest";
import { pageTreeItemCount, pageTreeLeaves } from "../../lib/page-to-tree.js";

import { accessPageTree } from "./page-tree.js";

import {
  ACCESS_LABELS,
  ACCESS_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
describe("access page tree", () => {
  it("turns each Access tab into a subtree of that tab's page panels", () => {
    const tree = accessPageTree();
    expect(tree.map((node) => node.label)).toEqual(
      ACCESS_VIEWS.map((id) => ACCESS_LABELS[id]),
    );
    // Every tab is the same kind of row: a sibling that opens onto its panels.
    expect(
      tree.filter((node) => node.children.length > 0).map((node) => node.id),
    ).toEqual([...ACCESS_VIEWS]);
    const headings = (id: string) =>
      tree.find((node) => node.id === id)?.children.map((node) => node.label);
    expect(headings("grants")).toEqual([
      "Local application grants",
      "Identity shares",
    ]);
    expect(headings("requests")).toEqual(["Local requests"]);
    expect(headings("resources")).toEqual(["Local resources"]);
    expect(headings("connectors")).toEqual(["Connectors"]);
    expect(headings("policies")).toEqual(["Local application policies"]);
    // No tab is nested under another: panels are the only second level.
    const views: readonly string[] = ACCESS_VIEWS;
    expect(
      tree
        .flatMap((node) => node.children)
        .filter((node) => views.includes(node.id)),
    ).toEqual([]);
    // Only the shares list records; a panel with none to list opens onto nothing.
    expect(
      tree
        .flatMap((node) => node.children)
        .filter((node) => node.collection)
        .map((node) => node.id),
    ).toEqual(["identity-shares"]);
    expect(pageTreeLeaves(tree)).toEqual([]);
    expect(tree.every((node) => pageTreeItemCount(node) === 0)).toBe(true);
  });

  it("names only panels the page draws: each conditional one when it draws, never a Host panel", () => {
    const tree = accessPageTree({
      identity: true,
      book: true,
      receipts: true,
      shares: [{ id: "s1", label: "vault: Budget" }],
    });
    const ids = tree.flatMap((node) => node.children.map((child) => child.id));
    expect(ids).toEqual([
      "access-book",
      "local-grants",
      "identity-shares",
      "hosted-requests",
      "local-requests",
      "sent-drops",
      "local-sessions",
      "local-authority-templates",
      "vault-share-sessions",
      "access-receipts",
      "local-connectors",
      "local-resources",
      "local-policies",
    ]);
    expect(ids.filter((id) => id.startsWith("host-"))).toEqual([]);
    expect(
      tree.find((node) => node.id === "requests")?.children[0]?.label,
    ).toBe("Requests for you");
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "vault: Budget",
    ]);
    const grants = tree.find((node) => node.id === "grants");
    expect(grants && pageTreeItemCount(grants)).toBe(1);
  });
});
