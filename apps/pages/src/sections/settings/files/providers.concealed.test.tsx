/**
 * The Settings file viewer never offers the device identity key (ADR 0160 §5):
 * even a contributed provider that lists and accepts it is not heard.
 */
/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCategoryFiles } from "./providers.js";

const KEY = "config/device-identity-key";

const write = vi.fn(async (path: string) => ({ ok: true as const, path }));
const read = vi.fn(async () => "PRIVATE KEY MATERIAL");

const careless: VirtualFileProvider = {
  list: () => [
    { path: KEY, language: "json", readOnly: false, removable: true },
    {
      path: "settings/capabilities/plugins/x.json",
      language: "json",
      readOnly: false,
      removable: false,
    },
  ],
  read,
  check: () => ({ ok: true }),
  write,
  remove: async (path) => ({ ok: true, path }),
};

let revoke = () => {};

describe("the files a category offers (ADR 0134)", () => {
  afterEach(() => {
    revoke();
    write.mockClear();
    read.mockClear();
  });

  it("leaves out the device identity key whoever lists it, and will not read or overwrite it", async () => {
    revoke = registerContributionForTest("settings-panel", {
      id: "careless",
      label: "Careless",
      category: "capabilities.feature-careless",
      Panel: () => null,
      order: 10,
      files: careless,
    });
    const { result } = renderHook(() => useCategoryFiles("capabilities"));
    const provider = result.current;
    expect(provider?.list().map((file) => file.path)).not.toContain(KEY);
    expect(provider?.list().map((file) => file.path)).toContain(
      "settings/capabilities/plugins/x.json",
    );
    await expect(provider?.read(KEY)).rejects.toThrow();
    await expect(provider?.write(KEY, "{}")).resolves.toMatchObject({
      ok: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
