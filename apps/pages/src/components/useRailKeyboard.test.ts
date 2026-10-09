/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { railMoveNavigates } from "./useRailKeyboard.js";

type RailRowAttrs = {
  expanded?: "true" | "false";
  level: string;
};

function row(attrs: RailRowAttrs): HTMLElement {
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

  it.each(["access", "identity"])(
    "keeps a collapsed %s view in the phone tree until expansion",
    (section) => {
      expect(
        railMoveNavigates(
          row({ expanded: "false", level: "2" }),
          row({ level: "1" }),
          `/${section}?view=sessions`,
          `/${section}`,
          true,
        ),
      ).toBe(false);
    },
  );

  it.each(["access", "identity", "vault"])(
    "preserves ordinary %s query previews outside a phone record tree",
    (section) => {
      expect(
        railMoveNavigates(
          row({ expanded: "false", level: "2" }),
          row({ level: "1" }),
          `/${section}?view=sessions`,
          `/${section}`,
        ),
      ).toBe(true);
    },
  );

  it("previews an expanded view", () => {
    expect(
      railMoveNavigates(
        row({ expanded: "true", level: "2" }),
        row({ level: "2" }),
        "/access?view=sessions",
        "/access?view=grants",
      ),
    ).toBe(true);
  });

  it("previews a leaf once its group is expanded", () => {
    const leaf = row({ level: "4" });
    expect(
      railMoveNavigates(
        leaf,
        row({ expanded: "true", level: "3" }),
        "/connections#catalog-github",
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
