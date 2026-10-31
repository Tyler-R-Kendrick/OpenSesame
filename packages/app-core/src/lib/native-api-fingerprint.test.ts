import { describe, expect, it } from "vitest";
import type { NativeApiTarget } from "./native-api-target.js";
import { nativeApiFingerprint, nativeApiTarget } from "./native-api-target.js";

/**
 * A saved API-key connection keeps the fingerprint of the contract it was
 * configured under, and is refused once that changes. These values were
 * computed on `main` at 2e909e1c8, before any contract could name a proof
 * status. A contract change that is meant to send people back to configure
 * again updates them on purpose.
 */
const SAVED = {
  openai: "a7808ca240341d4b52b40a42fc1bfb58c413d7912c149d4727147ae72bd1f929",
  datadog: "1619edd4c2e5553a9f994151d16fb849b5ce1b938dae83fc73a0bc01a7df0e57",
};

function proving(target: NativeApiTarget): NativeApiTarget {
  const verify = target.profile.verify;
  if (!verify) throw new Error("Expected a verify contract");
  return {
    ...target,
    profile: { ...target.profile, verify: { ...verify, validStatuses: [404] } },
  };
}

describe("a saved API-key connection's fingerprint", () => {
  it("is unchanged for a contract that names no proof status", async () => {
    for (const [id, saved] of Object.entries(SAVED)) {
      const target = nativeApiTarget(id, {});
      expect(await nativeApiFingerprint(target), id).toBe(saved);
    }
  });

  it("changes when a contract names one", async () => {
    const plain = nativeApiTarget("openai", {});
    expect(await nativeApiFingerprint(proving(plain))).not.toBe(
      await nativeApiFingerprint(plain),
    );
  });
});
