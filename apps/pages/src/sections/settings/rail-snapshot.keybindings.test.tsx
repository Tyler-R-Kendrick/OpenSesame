/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubPointer } from "../../lib/use-narrow.test-support.js";
import { settingsPageSources } from "./page-tree.js";
import { useSettingsPanels } from "./rail-snapshot.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Router({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/settings"]}>{children}</MemoryRouter>;
}

/** The settings tree the rail draws from what the page itself reports. */
function railTabs(): string[] {
  const { result } = renderHook(() => useSettingsPanels(), {
    wrapper: Router,
  });
  return settingsPageSources(result.current).map((tab) => tab.id);
}

describe("the rail's settings tree", () => {
  it("has no /settings/keybindings entry on a touch-only device", () => {
    stubPointer(false);
    const tabs = railTabs();
    expect(tabs).not.toContain("keybindings");
    expect(tabs).toContain("general");
  });

  it("lists it where a fine pointer is attached", () => {
    stubPointer(true);
    expect(railTabs()).toContain("keybindings");
  });
});
