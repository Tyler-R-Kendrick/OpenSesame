/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { railMoveNavigates } from "./useRailKeyboard.js";

function row(attrs: {
  expanded?: "true" | "false";
  level: string;
}): HTMLElement {
  const node = document.createElement("a");
  node.setAttribute("aria-level", attrs.level);
  if (attrs.expanded) node.setAttribute("aria-expanded", attrs.expanded);
  return node;
}

describe("railMoveNavigates", () => {
  it("does not index the catalog while a group is collapsed", () => {
    const encryption = row({ expanded: "false", level: "3" });
    expect(
      railMoveNavigates(
        encryption,
        row({ level: "3" }),
        "/connections#catalog-encryption",
        "/connections#catalog",
      ),
    ).toBe(false);
  });

  it("previews a leaf once its group is expanded", () => {
    const leaf = row({ level: "4" });
    expect(
      railMoveNavigates(
        leaf,
        row({ expanded: "true", level: "3" }),
        "/connections#catalog-age",
        "/connections#catalog-encryption",
      ),
    ).toBe(true);
  });

  it("still opens a collapsed section that is a different page", () => {
    const connections = row({ expanded: "false", level: "1" });
    expect(
      railMoveNavigates(
        connections,
        row({ level: "2" }),
        "/connections",
        "/vault?f=trash",
      ),
    ).toBe(true);
  });
});
