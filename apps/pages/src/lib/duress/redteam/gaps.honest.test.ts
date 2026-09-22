import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * REDTEAM-F — honest gaps. Fail until owning swarms close the surface.
 * Do not delete; refresh `.duress-swarm/requests/*` instead.
 */
import { describe, expect, it } from "vitest";
import { loadDuressRuntime, resolveDuressMode } from "../feature/mode.js";

const here = dirname(fileURLToPath(import.meta.url));
const pagesSrc = join(here, "..", "..", "..");

describe("REDTEAM-F honest gaps (must not force-pass)", () => {
  it("GAP-UNLOCK-WIRE: unlock road bridges to routeCompleteUnlockSubmission", () => {
    const bridge = join(
      pagesSrc,
      "sections",
      "settings",
      "security",
      "duress-unlock-bridge.ts",
    );
    const pinGate = join(pagesSrc, "screens", "unlock", "unlock-pin-duress.ts");
    const passwordGate = join(
      pagesSrc,
      "screens",
      "unlock",
      "unlock-password-duress.ts",
    );
    const formPaths = join(
      pagesSrc,
      "screens",
      "unlock",
      "unlock-form-paths.ts",
    );
    expect(existsSync(bridge)).toBe(true);
    expect(existsSync(pinGate)).toBe(true);
    expect(existsSync(passwordGate)).toBe(true);
    expect(existsSync(formPaths)).toBe(true);
    const bridgeBody = readFileSync(bridge, "utf8");
    const pinBody = readFileSync(pinGate, "utf8");
    const passwordBody = readFileSync(passwordGate, "utf8");
    const pathsBody = readFileSync(formPaths, "utf8");
    expect(bridgeBody).toMatch(/routeCompleteUnlockSubmission/);
    expect(pinBody).toMatch(/onCompleteUnlockCodeSubmission/);
    expect(passwordBody).toMatch(/onCompleteUnlockCodeSubmission/);
    expect(pathsBody).toMatch(/unlockWithPinAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockWithPasswordAfterDuressGate/);
  });

  it("GAP-SETTINGS-NAV: DuressProfilesPanel is not referenced from settings shell", async () => {
    const shellCandidates = [
      join(pagesSrc, "sections", "settings", "SettingsSecurity.tsx"),
      join(pagesSrc, "sections", "settings", "security", "index.ts"),
      join(pagesSrc, "sections", "settings", "security", "SecuritySheet.tsx"),
    ];
    const anyShell = shellCandidates.some((p) => existsSync(p));
    // Panel component exists; navigation mount is the gap.
    const panel = join(
      pagesSrc,
      "sections",
      "settings",
      "security",
      "DuressProfilesPanel.tsx",
    );
    expect(existsSync(panel)).toBe(true);
    expect(
      anyShell,
      "No settings security shell wiring DuressProfilesPanel — see REDTEAM-to-SETTINGS-nav.md",
    ).toBe(true);

    // Mode remains off by default (INV-01) even when UI lands.
    expect(resolveDuressMode({})).toBe("off");
    const loaded = await loadDuressRuntime("off");
    expect(loaded.loaded).toBe(false);
  });
});
