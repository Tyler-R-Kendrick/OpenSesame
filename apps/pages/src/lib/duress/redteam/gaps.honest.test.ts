import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDuressRuntime,
  resolveDuressMode,
} from "@opensesame/app-core/lib/duress/feature/mode.js";
/**
 * REDTEAM-F — honest gaps. Fail until owning swarms close the surface.
 * Do not delete; refresh `.duress-swarm/requests/*` instead.
 */
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pagesSrc = join(here, "..", "..", "..");
const coreSrc = join(pagesSrc, "..", "..", "..", "packages", "app-core", "src");

/** A source path in the shell, or in the shared core it moved to (ADR 0133). */
function src(...parts: string[]): string {
  const shell = join(pagesSrc, ...parts);
  return existsSync(shell) ? shell : join(coreSrc, ...parts);
}

describe("REDTEAM-F honest gaps (must not force-pass)", () => {
  it("GAP-UNLOCK-WIRE: unlock roads gate PIN/password/passkey/second-step", () => {
    const bridge = src(
      "sections",
      "settings",
      "security",
      "duress-unlock-bridge.ts",
    );
    const pinGate = src("screens", "unlock", "unlock-pin-duress.ts");
    const passwordGate = src("screens", "unlock", "unlock-password-duress.ts");
    const passkeyGate = src("screens", "unlock", "unlock-passkey-duress.ts");
    const secondStepGate = src(
      "screens",
      "unlock",
      "unlock-second-step-duress.ts",
    );
    const continueGate = src("screens", "unlock", "unlock-duress-continue.ts");
    const formPaths = src("screens", "unlock", "unlock-form-paths.ts");
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
      existsSync(src("screens", "unlock", "unlock-passkey-evidence.ts")),
    ).toBe(true);
    expect(pathsBody).toMatch(/unlockWithPinAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockWithPasswordAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockWithPasskeyAfterDuressGate/);
    expect(pathsBody).toMatch(/unlockSecondStepAfterDuressGate/);
  });

  it("GAP-SETTINGS-NAV: Settings shell mounts enrollment when mode is non-off", async () => {
    const settingsSection = src("sections", "SettingsSection.tsx");
    const securityShell = src("sections", "settings", "SettingsSecurity.tsx");
    const panel = src(
      "sections",
      "settings",
      "security",
      "DuressProfilesPanel.tsx",
    );
    const enrollment = src(
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
