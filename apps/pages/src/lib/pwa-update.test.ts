import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForAppUpdate, pwaUpdateSeams } from "./pwa-update.js";

const original = {
  serviceWorkerContainer: pwaUpdateSeams.serviceWorkerContainer,
};

afterEach(() => {
  Object.assign(pwaUpdateSeams, original);
});

describe("checkForAppUpdate", () => {
  it("returns false when service workers are unavailable", async () => {
    pwaUpdateSeams.serviceWorkerContainer = () => null;
    await expect(checkForAppUpdate()).resolves.toBe(false);
  });

  it("returns false when nothing is registered", async () => {
    // SAFETY: stub only implements getRegistration for this probe.
    pwaUpdateSeams.serviceWorkerContainer = () =>
      overlapCast({
        getRegistration: () => Promise.resolve(undefined),
      });
    await expect(checkForAppUpdate()).resolves.toBe(false);
  });

  it("asks the registration to update and reports success", async () => {
    const update = vi.fn(() => Promise.resolve());
    // SAFETY: stub registration only needs update(); the probe never reads
    // active/installing/waiting.
    pwaUpdateSeams.serviceWorkerContainer = () =>
      overlapCast({
        getRegistration: () => Promise.resolve(overlapCast({ update })),
      });
    await expect(checkForAppUpdate()).resolves.toBe(true);
    expect(update).toHaveBeenCalledOnce();
  });

  it("returns false when the update probe fails", async () => {
    // SAFETY: stub only implements getRegistration for this probe.
    pwaUpdateSeams.serviceWorkerContainer = () =>
      overlapCast({
        getRegistration: () => Promise.reject(new Error("offline")),
      });
    await expect(checkForAppUpdate()).resolves.toBe(false);
  });
});
