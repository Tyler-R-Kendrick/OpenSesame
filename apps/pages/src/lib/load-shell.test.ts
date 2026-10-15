/** @vitest-environment jsdom */
import { STALE_BUILD } from "@opensesame/app-core/lib/chunk-load.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importAppRoot, loadShellSeams } from "./load-shell.js";
import { pwaUpdateSeams } from "./pwa-update.js";

const update = vi.fn(async () => undefined);
const originalPwa = { ...pwaUpdateSeams };
const originalImport = loadShellSeams.importAppRootModule;

afterEach(() => {
  vi.clearAllMocks();
  Object.assign(pwaUpdateSeams, originalPwa);
  loadShellSeams.importAppRootModule = originalImport;
});

describe("importAppRoot", () => {
  it("maps a chunk load failure to STALE_BUILD and asks for a new shell", async () => {
    Object.assign(pwaUpdateSeams, {
      serviceWorkerContainer: () => ({
        getRegistration: async () => ({ update }),
      }),
    });
    loadShellSeams.importAppRootModule = async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    };
    await expect(importAppRoot()).rejects.toThrow(STALE_BUILD);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
