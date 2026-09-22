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
  it("GAP-UNLOCK-WIRE: unlock roads gate PIN/password/passkey/second-step", () => {
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
    const passkeyGate = join(
      pagesSrc,
      "screens",
      "unlock",
      "unlock-passkey-duress.ts",
    );
    const secondStepGate = join(
      pagesSrc,
      "screens",
      "unlock",
      "unlock-second-step-duress.ts",
    );
    const continueGate = join(
      pagesSrc,
      "screens",
      "unlock",
      "unlock-duress-continue.ts",
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
    expect(existsSync(passkeyGate)).toBe(true);
    expect(existsSync(secondStepGate)).toBe(true);
    expect(existsSync(continueGate)).toBe(true);
    expect(existsSync(formPaths)).toBe(true);
    const bridgeBody = readFileSync(bridge, "utf8");
    const pinBody = readFileSync(pinGate, "utf8");
    const passwordBody = readFileSync(passwordGate, "utf8");
    const passkeyBody = readFileSync(passkeyGate, "utf8");
    const secondBody = readFileSync(secondStepGate, "utf8");
    const continueBody = readFileSync(continueGate, "utf8");
    const pathsBody = readFileSync(formPaths, "utf8");
    expect(bridgeBody).toMatch(/routeCompleteUnlockSubmission/);
    expect(pinBody).toMatch(/onCompleteUnlockCodeSubmission/);
    expect(passwordBody).toMatch(/onCompleteUnlockCodeSubmission/);
    expect(secondBody).toMatch(/onCompleteUnlockCodeSubmission/);
    expect(passkeyBody).toMatch(/armedTwoInputTrigger|prf_and_code/);
    expect(continueBody).toMatch(/createGuest/);
    expect(continueBody).toMatch(/mintPresentationSession/);
    expect(continueBody).toMatch(/openPresentation/);
    expect(readFileSync(bridge, "utf8")).toMatch(/options\.select|select\?:/);
    expect(
      existsSync(
        join(pagesSrc, "screens", "unlock", "unlock-passkey-evidence.ts"),
      ),
    ).toBe(true);
    expect(pathsBody).toMatch(/unlockWithPinAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockWithPasswordAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockWithPasskeyAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockSecondStepAfterDuressGate/);
  });

  it("GAP-SETTINGS-NAV: Settings shell mounts enrollment when mode is non-off", async () => {
    const settingsSection = join(pagesSrc, "sections", "SettingsSection.tsx");
    const securityShell = join(
      pagesSrc,
      "sections",
      "settings",
      "SettingsSecurity.tsx",
    );
    const panel = join(
      pagesSrc,
      "sections",
      "settings",
      "security",
      "DuressProfilesPanel.tsx",
    );
    const enrollment = join(
      pagesSrc,
      "routes",
      "settings",
      "security",
      "DuressEnrollmentPanel.tsx",
    );
    expect(existsSync(panel)).toBe(true);
    expect(existsSync(enrollment)).toBe(true);
    expect(existsSync(settingsSection)).toBe(true);
    expect(existsSync(securityShell)).toBe(true);
    const section = readFileSync(settingsSection, "utf8");
    expect(section).toMatch(/DuressEnrollmentPanel/);
    expect(section).toMatch(/resolveDuressMode\(\{\}\) !== "off"/);

    // Mode remains off by default (INV-01) even when UI lands.
    expect(resolveDuressMode({})).toBe("off");
    const loaded = await loadDuressRuntime("off");
    expect(loaded.loaded).toBe(false);
  });
});
