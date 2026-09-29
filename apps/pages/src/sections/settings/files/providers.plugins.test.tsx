/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCategoryFiles } from "./providers.js";

const PATH = "settings/capabilities/plugins/surrogate-proxy.json";

const files: VirtualFileProvider = {
  list: () => [
    { path: PATH, language: "json", readOnly: true, removable: false },
  ],
  read: async () => '{"id":"surrogate-proxy"}\n',
  check: () => ({ ok: false, message: "read-only" }),
  write: async () => ({ ok: false, message: "read-only" }),
  remove: async () => ({ ok: false, message: "read-only" }),
};

let revokes: Array<() => void> = [];

describe("a panel's files under its category (ADR 0134)", () => {
  afterEach(() => {
    for (const revoke of revokes) revoke();
    revokes = [];
  });

  it("lists a Capabilities section panel's file under Capabilities, one provider across renders", async () => {
    revokes.push(
      registerContributionForTest("settings-panel", {
        id: "plugin-surrogate-proxy",
        label: "Surrogate proxy",
        category: "capabilities.feature-surrogates",
        Panel: () => null,
        order: 10,
        files,
      }),
    );
    const { result, rerender } = renderHook(() =>
      useCategoryFiles("capabilities"),
    );
    const first = result.current;
    const paths = first?.list().map((file) => file.path) ?? [];
    expect(paths).toContain(
      "settings/capabilities/installation-selection.yaml",
    );
    expect(paths).toContain(PATH);
    expect(await first?.read(PATH)).toContain("surrogate-proxy");
    rerender();
    expect(result.current).toBe(first);
  });

  it("lists the capability documents when no panel adds a file", () => {
    const { result } = renderHook(() => useCategoryFiles("capabilities"));
    expect(result.current?.list().map((file) => file.path)).toContain(
      "settings/capabilities/installation-selection.yaml",
    );
  });

  it("does not list a panel's file under a category it is not drawn in", () => {
    revokes.push(
      registerContributionForTest("settings-panel", {
        id: "plugin-surrogate-proxy",
        label: "Surrogate proxy",
        category: "capabilities.feature-surrogates",
        Panel: () => null,
        order: 10,
        files,
      }),
    );
    const { result } = renderHook(() => useCategoryFiles("general"));
    expect(result.current).toBeNull();
  });
});
