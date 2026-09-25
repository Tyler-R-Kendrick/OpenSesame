import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AmbientAuthSeams,
  type AmbientCompleted,
  ambientAuthSeams,
  ambientSeamTimers,
  installAmbientAuthSeams,
  resetAmbientAuthSeams,
} from "./ambient-auth-seam.js";

function implementation(
  applyAmbientReturn: AmbientAuthSeams["applyAmbientReturn"],
): AmbientAuthSeams {
  return {
    autoAuthSuppressed: () => false,
    clearAutoAuthSuppression: () => {},
    fenceLocalSignOut: () => {},
    cancelAllTransactions: () => {},
    applyAmbientReturn,
  };
}

/* SAFETY: the seam forwards the completed sign-in untouched and no field of it is read on this path, so an empty fixture record stands in for one. */
const COMPLETED = {} as AmbientCompleted;

describe("an ambient return that lands before the capability is installed", () => {
  afterEach(() => {
    resetAmbientAuthSeams();
    vi.restoreAllMocks();
  });

  it("waits for the capability and settles through it, not as nothing", async () => {
    const apply = vi.fn(async () => ({ returnTo: "/vault" }));
    const settled = ambientAuthSeams.applyAmbientReturn(COMPLETED);
    installAmbientAuthSeams(implementation(apply));
    await expect(settled).resolves.toEqual({ returnTo: "/vault" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("waits again across a plan generation's dispose and activate", async () => {
    installAmbientAuthSeams(implementation(async () => ({})));
    resetAmbientAuthSeams();
    const apply = vi.fn(async () => ({ returnTo: "/identity" }));
    const settled = ambientAuthSeams.applyAmbientReturn(COMPLETED);
    installAmbientAuthSeams(implementation(apply));
    await expect(settled).resolves.toEqual({ returnTo: "/identity" });
  });

  it("settles as nothing to apply once the bound passes with no capability", async () => {
    vi.spyOn(ambientSeamTimers, "wait").mockResolvedValue(undefined);
    await expect(
      ambientAuthSeams.applyAmbientReturn(COMPLETED),
    ).resolves.toEqual({});
  });
});
