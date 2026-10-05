/** @vitest-environment jsdom */

import { createItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultStore } from "../../lib/vault/store.js";
import { guideNavigationPath } from "./vault-routes.js";

const here = (pathname: string, search = "") => ({ pathname, search });

function holding(...items: ReturnType<typeof createItem>[]) {
  return vi
    .spyOn(vaultStore, "getSnapshot")
    .mockReturnValue({ ...vaultStore.getSnapshot(), items });
}

afterEach(() => vi.restoreAllMocks());

describe("where a tour's navigate goes", () => {
  it("leaves an ordinary route as it is", () => {
    expect(guideNavigationPath("/vault", here("/settings"))).toBe("/vault");
    expect(guideNavigationPath("/vault/health", here("/vault"))).toBe(
      "/vault/health",
    );
  });

  it("opens the first item that is not in the trash", () => {
    const trashed = {
      ...createItem("secret", "gone"),
      id: "itm_gone",
      deletedAt: "2026-09-01T00:00:00Z",
    };
    const live = { ...createItem("secret", "here"), id: "itm_live" };
    holding(trashed, live);
    expect(guideNavigationPath("/vault/item", here("/vault"))).toBe(
      "/vault/itm_live",
    );
  });

  it("stays on the item that is already open", () => {
    holding({ ...createItem("secret", "one"), id: "itm_one" });
    expect(guideNavigationPath("/vault/item", here("/vault/itm_other"))).toBe(
      null,
    );
  });

  it("goes nowhere when there is no item to open", () => {
    holding();
    expect(guideNavigationPath("/vault/item", here("/vault"))).toBeNull();
    holding({
      ...createItem("secret", "gone"),
      deletedAt: "2026-09-01T00:00:00Z",
    });
    expect(guideNavigationPath("/vault/item", here("/vault"))).toBeNull();
  });

  it("opens the trash, and stays in it", () => {
    expect(guideNavigationPath("/vault/trash", here("/vault"))).toBe(
      "/vault?f=trash",
    );
    expect(
      guideNavigationPath("/vault/trash", here("/vault", "?f=trash")),
    ).toBeNull();
  });
});
