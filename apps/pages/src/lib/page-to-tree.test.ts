import { describe, expect, it } from "vitest";
import {
  hrefContainsCurrent,
  limitPageTree,
  pageTabTree,
  pageToTree,
  pageTreeContains,
  pageTreeItemCount,
  pageTreeLeaves,
} from "./page-to-tree.js";

const cloud = {
  id: "cloud",
  label: "Cloud",
  href: "/page#cloud",
  items: [
    { id: "zulu", label: "Zulu", href: "/page/zulu" },
    { id: "alpha", label: "Alpha", href: "/page/alpha" },
  ],
};
const passwords = {
  id: "passwords",
  label: "Passwords",
  href: "/page#passwords",
  items: [{ id: "mid", label: "Mid", href: "/page/mid" }],
};

describe("pageToTree", () => {
  it("keeps page order and turns subheaders into nested subtrees", () => {
    const tree = pageToTree([
      { id: "inbox", label: "Inbox", href: "/page#inbox", keepEmpty: true },
      {
        id: "catalog",
        label: "Catalog",
        href: "/page#catalog",
        sections: [cloud, passwords],
      },
    ]);
    expect(tree.map((node) => node.id)).toEqual(["inbox", "catalog"]);
    expect(tree[1]?.children.map((node) => node.id)).toEqual([
      "cloud",
      "passwords",
    ]);
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "Zulu",
      "Alpha",
      "Mid",
    ]);
  });

  it("drops empty subheaders unless the page still shows them", () => {
    expect(
      pageToTree([{ id: "ghost", label: "Ghost", href: "/page#ghost" }]),
    ).toEqual([]);
    expect(
      pageToTree([
        { id: "shown", label: "Shown", href: "/page#shown", keepEmpty: true },
      ])[0]?.children,
    ).toEqual([]);
  });
});

describe("pageTabTree", () => {
  it("turns page tabs into sibling subtrees in tab order", () => {
    const tree = pageTabTree([
      {
        id: "grants",
        label: "Grants",
        href: "/access?view=grants",
        items: [
          {
            id: "local-grants",
            label: "Local application grants",
            href: "/access?view=grants#local-grants",
          },
        ],
      },
      { id: "requests", label: "Requests", href: "/access?view=requests" },
    ]);
    expect(tree.map((node) => node.label)).toEqual(["Grants", "Requests"]);
    expect(tree.every((node) => node.branch)).toBe(true);
    expect(tree[0]?.children.map((node) => node.label)).toEqual([
      "Local application grants",
    ]);
    expect(tree[1]?.children).toEqual([]);
  });
});

describe("pageTreeItemCount", () => {
  it("counts items, not tab or heading folders", () => {
    const tree = pageTabTree([
      {
        id: "people",
        label: "People",
        href: "/identity?view=people",
        items: [
          { id: "alice", label: "Alice", href: "/identity?view=people#alice" },
          { id: "bob", label: "Bob", href: "/identity?view=people#bob" },
        ],
      },
      {
        id: "grants",
        label: "Grants",
        href: "/access?view=grants",
        sections: [
          {
            id: "local-grants",
            label: "Local application grants",
            href: "/access?view=grants#local-grants",
            keepEmpty: true,
          },
          {
            id: "identity-shares",
            label: "Identity shares",
            href: "/access?view=grants#identity-shares",
            keepEmpty: true,
            items: [
              {
                id: "share-1",
                label: "vault: Budget",
                href: "/access?view=grants#share-1",
              },
            ],
          },
        ],
      },
    ]);
    const people = tree.find((node) => node.id === "people");
    const grants = tree.find((node) => node.id === "grants");
    expect(people && pageTreeItemCount(people)).toBe(2);
    expect(grants && pageTreeItemCount(grants)).toBe(1);
    expect(grants?.children.every((node) => node.branch)).toBe(true);
  });

  it("lets a tree override the count", () => {
    const tree = pageToTree([
      {
        id: "connected",
        label: "Connected",
        href: "/connections#connected",
        keepEmpty: true,
        count: 4,
        items: [{ id: "one", label: "One", href: "/connections/one" }],
      },
    ]);
    expect(tree[0] && pageTreeItemCount(tree[0])).toBe(4);
  });
});

describe("limitPageTree", () => {
  it("takes leaves in page order and keeps their subheaders", () => {
    const limited = pageToTree(limitPageTree([cloud, passwords], 2));
    expect(pageTreeLeaves(limited).map((node) => node.id)).toEqual([
      "zulu",
      "alpha",
    ]);
    expect(limited.map((node) => node.id)).toEqual(["cloud"]);
  });
});

describe("pageTreeContains", () => {
  it("treats a hash prefix as the parent of its nested anchors", () => {
    expect(
      hrefContainsCurrent("/connections#catalog", "/connections#catalog"),
    ).toBe(true);
    expect(
      hrefContainsCurrent(
        "/connections#catalog",
        "/connections#catalog-developer",
      ),
    ).toBe(true);
    expect(
      hrefContainsCurrent("/connections#catalog", "/connections#connected"),
    ).toBe(false);
  });

  it("walks descendants so a connected instance keeps its parent open", () => {
    const tree = pageToTree([
      {
        id: "connected",
        label: "Connected",
        href: "/connections#connected",
        items: [
          {
            id: "region-b",
            label: "region-b",
            href: "/connections/provider-0/region-b",
          },
        ],
      },
    ]);
    const root = tree[0];
    expect(root).toBeDefined();
    expect(pageTreeContains(root, "/connections/provider-0/region-b")).toBe(
      true,
    );
    expect(pageTreeContains(root, "/connections#catalog")).toBe(false);
  });
});
