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
      "Local sessions",
      "Audience templates",
      "Vault share sessions",
      "Host shared sessions",
      "Host task sessions",
      "Connectors",
      "Local resources",
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
