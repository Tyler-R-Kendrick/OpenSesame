import { describe, expect, it } from "vitest";
import type { Provider } from "../../lib/connections.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { pageTreeLeaves } from "../../lib/page-to-tree.js";
import { catalogPageSections, connectionsPageTree } from "./page-tree.js";

const template = getBundledProviders()[0];
if (!template) throw new Error("Bundled catalog must not be empty");

function provider(
  id: string,
  displayName: string,
  category: Provider["category"],
): Provider {
  return { ...template, id, displayName, category, autoConfigurable: false };
}

describe("connections page tree", () => {
  it("keeps catalog source order under page subheaders, not alphabetical", () => {
    const groups = catalogPageSections([
      provider("zulu", "Zulu Cloud", "developer"),
      provider("alpha", "Alpha Cloud", "developer"),
      provider("mid", "Mid Pass", "password_managers"),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Password managers",
      "Developer tools",
    ]);
    expect(groups[0]?.items?.map((item) => item.label)).toEqual(["Mid Pass"]);
    expect(groups[1]?.items?.map((item) => item.label)).toEqual([
      "Zulu Cloud",
      "Alpha Cloud",
    ]);
  });

  it("puts Needs attention and Connected before catalog groups", () => {
    const tree = connectionsPageTree(
      [provider("zulu", "Zulu Cloud", "developer")],
      [],
    );
    expect(tree.map((node) => node.label)).toEqual([
      "Connected",
      "Add a connection",
    ]);
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "Zulu Cloud",
    ]);
  });
});
