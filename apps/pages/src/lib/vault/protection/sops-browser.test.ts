import { describe, expect, it } from "vitest";
import { generateAgeKeyPair } from "../../age-keys.js";
import {
  ageCapability,
  exportAgeArmored,
  exportNativeManifestJson,
  importAgeArmored,
  sopsCapability,
} from "./sops-browser.js";
import type { RootProtectionManifest } from "./types.js";

describe("sops-browser formats interop", () => {
  it("reports honest capabilities", () => {
    expect(ageCapability().runtime).toBe("browser");
    expect(sopsCapability().runtime).toBe("browser");
  });

  it("exports native manifest JSON", () => {
    const manifest = {
      schemaVersion: 1,
      vaultId: "v",
      rootKeyId: "r",
      rootEpoch: 0,
      revision: 0,
      purpose: "human-vault-root",
      records: [],
    } satisfies RootProtectionManifest;
    expect(exportNativeManifestJson(manifest)).toContain('"vaultId": "v"');
  });

  it("round-trips age armored payloads both directions", async () => {
    const pair = await generateAgeKeyPair();
    const plain = new TextEncoder().encode("protection-payload");
    const armored = await exportAgeArmored(plain, [pair.recipient]);
    expect(armored).toMatch(/BEGIN AGE ENCRYPTED FILE/);
    const opened = await importAgeArmored(armored, pair.identity);
    expect(new TextDecoder().decode(opened)).toBe("protection-payload");
  });
});
