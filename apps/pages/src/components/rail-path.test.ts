import { describe, expect, it } from "vitest";
import { nextSectionOpen, rowSelected } from "./PageTreeBranch.js";
import { selectedRailPath } from "./rail-path.js";

describe("shared rail branch helpers", () => {
  it("seeds open only by flipping the current section", () => {
    expect(nextSectionOpen(true, true)).toBe(false);
    expect(nextSectionOpen(true, false)).toBe(true);
    expect(nextSectionOpen(false, false)).toBe(true);
    expect(nextSectionOpen(false, true)).toBe(true);
  });

  it("selects a row by href or preview path", () => {
    expect(rowSelected("/vault?f=login", { href: "/vault?f=login" })).toBe(
      true,
    );
    expect(
      rowSelected("/connections#catalog-github", {
        href: "/connections/github",
        selectTo: "/connections#catalog-github",
      }),
    ).toBe(true);
    expect(rowSelected("/vault", { href: "/settings" })).toBe(false);
  });
});

describe("the rail path for password health", () => {
  it("stands on the health page while that report is open", () => {
    expect(
      selectedRailPath("/vault/health", "", null, "all", null, "general"),
    ).toBe("/vault/health");
    expect(
      selectedRailPath(
        "/vault/health/",
        "",
        null,
        "favorites",
        null,
        "general",
      ),
    ).toBe("/vault/health");
  });

  it("keeps a vault filter on its own row", () => {
    expect(selectedRailPath("/vault", "", null, "all", null, "general")).toBe(
      "/vault",
    );
    expect(
      selectedRailPath("/vault", "", null, "favorites", null, "general"),
    ).toBe("/vault?f=favorites");
  });
});

it("keeps canonical share URLs and legacy access routes on the actual rail entry", () => {
  expect(
    selectedRailPath(
      "/access",
      "#identity-shares/share-1",
      "grants",
      "all",
      null,
      "general",
    ),
  ).toBe("/access?view=grants#share-share-1");
  expect(
    selectedRailPath(
      "/access/sessions",
      "#local-sessions/session-1",
      null,
      "all",
      null,
      "general",
    ),
  ).toBe("/access?view=sessions#local-sessions");
  expect(
    selectedRailPath(
      "/wallet/budgets",
      "#budget-1",
      null,
      "all",
      null,
      "general",
    ),
  ).toBe("/wallet/budgets#budget-1");
});
