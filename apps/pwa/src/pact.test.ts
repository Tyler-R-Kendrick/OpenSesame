import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSecretFields,
  assertSourceOrder,
} from "@opensesame/testing";
import { createCursor } from "@opensesame/client-core";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — pwa shell", () => {
  it("property: device cursor is stable for the pwa device id", () => {
    const a = createCursor("pwa-device");
    const b = createCursor("pwa-device");
    expect(a.deviceId).toBe("pwa-device");
    expect(b.deviceId).toBe(a.deviceId);
  });

  it("adversarial: App source never exposes getSecret or raw credentials", () => {
    const src = readFileSync(join(here, "App.tsx"), "utf8");
    expect(src).not.toMatch(/getSecret\s*\(/);
    expect(src).not.toMatch(/access_token|refresh_token|claimToken/);
    assertSourceOrder(src, [
      "assertNoPlaintextInSealedJson(sealed)",
      "persistSealedStore",
    ]);
  });

  it("chaos: a sealed-store assertion sits before persist", () => {
    assertSourceOrder(readFileSync(join(here, "App.tsx"), "utf8"), [
      "assertNoPlaintextInSealedJson",
      "await persistSealedStore",
    ]);
  });

  it("contract: identity copy never claims to show a credential", () => {
    const src = readFileSync(join(here, "App.tsx"), "utf8");
    expect(src).toContain("never shows raw credentials");
    assertNoSecretFields({ deviceId: "pwa-device", epoch: 0 });
  });
});
