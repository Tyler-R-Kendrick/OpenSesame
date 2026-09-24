import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "../json-boundary.js";
import {
  PRESET_CATALOG,
  PRESET_IDS,
  SETTINGS_FIXTURE_CATALOG,
  activationRequiresNewPermissionPrompt,
  assertNoEnrolledCodeDisplay,
  buildOwnerStatusView,
  buildPresetPolicy,
  canArmProfile,
  disarmProfile,
  emptyArmingChecklist,
  enrollmentFocusOrder,
  explainArmBlockers,
  exportPolicyPreview,
  formatExposureLines,
  mobileLayoutHints,
  planRecipient,
  previewCompiledPolicy,
  previewImport,
  previewImportDocument,
  publicCodeSlotView,
  redactSecrets,
  rehearsalSatisfiesArming,
  replaceEnrolledCode,
  resolveMotionPreference,
  runIsolatedRehearsal,
  statusLabelsForAudience,
  statusViewForPresentation,
  validateRecipientSetup,
} from "./index.js";

const catalog = SETTINGS_FIXTURE_CATALOG;

const scope = {
  ownerPrincipalRef: "owner-1",
  organizationRef: null,
  vaultRef: "vault-1",
  deviceBindingRef: "device-1",
  compartmentRefs: ["comp-normal", "comp-restricted", "comp-decoy"],
} satisfies import("./presets.js").PresetScope;

describe("SETTINGS-A presets + compiler summaries", () => {
  it("covers every scenario preset id", () => {
    expect(PRESET_IDS).toHaveLength(PRESET_CATALOG.length);
    for (const id of PRESET_IDS) {
      const doc = buildPresetPolicy(id, {
        ...scope,
        compartmentRefs: [...scope.compartmentRefs, "comp-sensitive"],
      });
      expect(doc.enabled).toBe(false);
      expect(doc.profiles.length).toBe(1);
      const preview = previewCompiledPolicy(doc, catalog, {
        ownerConsent: false,
        rehearsalPassed: false,
        durableStorage: true,
        enrolledTriggers: false,
      });
      expect(
        preview.ok,
        `${id}: ${preview.diagnostics.map((d) => d.message).join("; ")}`,
      ).toBe(true);
      expect(preview.wouldArm).toBe(false);
    }
  });

  it("uses compiler exposures only (no duplicated security claims)", () => {
    const doc = buildPresetPolicy("SC-ALERT-ONLY", {
      ...scope,
      compartmentRefs: ["comp-normal"],
    });
    const preview = previewCompiledPolicy(doc, catalog, {
      ownerConsent: false,
      rehearsalPassed: false,
      durableStorage: true,
      enrolledTriggers: false,
    });
    expect(preview.ok).toBe(true);
    expect(preview.wouldArm).toBe(false);
    expect(preview.lines.some((l) => l.kind === "disclosure")).toBe(true);
    if (preview.ok) {
      const lines = formatExposureLines(
        preview.lines.length
          ? [
              {
                profileId: "alert-only",
                admittedCompartmentRefs: ["comp-normal"],
                deniedCompartmentRefs: [],
                unlockPathLabels: ["application_code"],
                alternateWrapperWarnings: [],
                historicalCopyDisclosure: true,
              },
            ]
          : [],
      );
      expect(lines.some((l) => l.includes("Historical"))).toBe(true);
    }
  });
});

describe("SETTINGS-B consent / rehearsal / recipients", () => {
  it("blocks arming until consent, destructive ack, rehearsal, and exposure review", () => {
    const checklist = emptyArmingChecklist({ durableStorage: true });
    expect(canArmProfile(checklist)).toBe(false);
    expect(explainArmBlockers(checklist)).toContain("owner_consent");
    expect(
      canArmProfile({
        ownerConsent: true,
        destructiveAck: true,
        rehearsalPassed: true,
        durableStorage: true,
        enrolledTriggers: true,
        exposureReviewed: true,
      }),
    ).toBe(true);
  });

  it("requires recipient/custodian setup for matching presets", () => {
    expect(
      validateRecipientSetup([], { recipient: true, custodian: false }),
    ).toEqual({ ok: false, reason: "alert_recipient_required" });
    const plan = planRecipient("alert_recipient", "r1", "Pager");
    expect(plan.cannot.some((c) => /never unlocks/i.test(c))).toBe(true);
    expect(
      validateRecipientSetup([plan], { recipient: true, custodian: false }),
    ).toEqual({ ok: true });
  });

  it("isolated rehearsal never applies production effects", () => {
    const passed = runIsolatedRehearsal({
      disposableFixtures: true,
      durableStorage: true,
      offlineAssetsReady: true,
      triggerSelectsExactlyOne: true,
      presentationClass: "unchanged",
      expectedPresentationClass: "unchanged",
      attemptedProductionAlert: false,
      attemptedProductionRemoval: false,
    });
    expect(rehearsalSatisfiesArming(passed)).toBe(true);
    expect(passed.productionEffectsApplied).toBe(false);
    expect(passed.halfArmedDestructiveCode).toBe(false);

    const aborted = runIsolatedRehearsal({
      disposableFixtures: true,
      durableStorage: true,
      offlineAssetsReady: true,
      triggerSelectsExactlyOne: true,
      presentationClass: "unchanged",
      expectedPresentationClass: "unchanged",
      attemptedProductionAlert: true,
      attemptedProductionRemoval: false,
    });
    expect(aborted.phase).toBe("aborted");
    expect(aborted.productionEffectsApplied).toBe(false);
  });
});

describe("SETTINGS-C codes / disarm / import", () => {
  it("never returns enrolled cleartext from replace/disarm/public view", async () => {
    const enrolled = await replaceEnrolledCode(
      {
        slotId: "s1",
        profileId: "p1",
        newCode: "12345678",
      },
      null,
    );
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    expect(JSON.stringify(enrolled.status)).not.toContain("12345678");
    expect("enrolledCode" in enrolled.status).toBe(false);
    const view = publicCodeSlotView(enrolled.status);
    expect(JSON.stringify(view)).not.toContain("12345678");
    // Nothing derived from the code either: no digest, not even a prefix.
    expect(Object.keys(view).sort()).toEqual([
      "enrolled",
      "lastReplacedAt",
      "profileId",
      "slotId",
    ]);
    expect(JSON.stringify(view)).not.toContain(
      enrolled.status.materialDigest.slice(0, 8),
    );
    const disarmed = disarmProfile(enrolled.status);
    expect(disarmed.enrolled).toBe(false);
    expect(assertNoEnrolledCodeDisplay({ code: "12345678" }).ok).toBe(false);
    expect(assertNoEnrolledCodeDisplay(enrolled.status).ok).toBe(true);
  });

  it("import enabled:true previews without arming", () => {
    const doc = {
      schemaVersion: 1 as const,
      policyId: "pol-import",
      revision: 1,
      enabled: true,
      profiles: buildPresetPolicy("SC-REHEARSAL", {
        ...scope,
        compartmentRefs: ["comp-normal"],
      }).profiles,
    } satisfies import("@opensesame/contracts/duress").PolicyDocument;
    const preview = previewImportDocument(doc, catalog);
    expect(preview.wouldArm).toBe(false);
    expect(preview.enabledFlag).toBe(true);
    const raw = previewImport(JSON.stringify(doc), catalog, "json");
    expect(raw.armed).toBe(false);
    expect(raw.warnings.some((w) => /preview only/i.test(w))).toBe(true);
    const exported = exportPolicyPreview(doc);
    expect(exported.containsSecrets).toBe(false);
  });
});

describe("SETTINGS-D status views", () => {
  it("hides sensitive labels on decoy/restricted foreground", () => {
    const owner = buildOwnerStatusView({
      armed: true,
      profileCount: 1,
      rehearsalPassed: true,
      incidentState: "active",
      recoveryPolicyRef: "recovery-1",
    });
    const decoy = statusLabelsForAudience(owner, "foreground_session", "decoy");
    expect(decoy).toEqual(["Vault available"]);
    expect(decoy.join(" ")).not.toMatch(/recovery|custodian|hold/i);

    const restricted = statusViewForPresentation("restricted", true);
    expect(restricted.showPolicyLabels).toBe(false);
    expect(restricted.showRecoveryControls).toBe(false);

    const authorized = statusViewForPresentation("normal", true);
    expect(authorized.showRecoveryControls).toBe(true);
  });
});

describe("SETTINGS-E accessibility", () => {
  it("honors reduced motion and mobile stacking", () => {
    expect(resolveMotionPreference({ matches: true })).toBe("reduced");
    expect(resolveMotionPreference({ matches: false })).toBe("full");
    expect(mobileLayoutHints(400).stackVertically).toBe(true);
    expect(mobileLayoutHints(900).stackVertically).toBe(false);
    const order = enrollmentFocusOrder();
    expect(order[0]?.id).toBe("duress-mode-preset");
    expect(order.some((i) => i.id === "duress-arm")).toBe(true);
  });
});

describe("SETTINGS-F malicious / accidental / permission absence", () => {
  it("redacts malicious operator secret fields", () => {
    const dirty = redactSecrets({
      label: "ok",
      unlockCode: "super-secret",
      nested: { pin: "9999", keep: true },
    });
    expect(dirty.unlockCode).toBe("[redacted]");
    const nested = dirty.nested;
    expect(isJsonObject(nested)).toBe(true);
    if (isJsonObject(nested)) {
      expect(overlapCast<JsonObject, { pin: string }>(nested).pin).toBe(
        "[redacted]",
      );
      expect(overlapCast<JsonObject, { keep: boolean }>(nested).keep).toBe(
        true,
      );
    }
  });

  it("accidental activation: import enabled alone cannot arm", () => {
    const checklist = emptyArmingChecklist({
      durableStorage: true,
      // simulating operator who only imported enabled:true
    });
    expect(canArmProfile(checklist)).toBe(false);
    expect(explainArmBlockers(checklist)).toEqual([
      "owner_consent",
      "destructive_ack",
      "isolated_rehearsal",
      "enrolled_triggers",
      "exposure_reviewed",
    ]);
  });

  it("activation never requests new browser permission prompts", () => {
    expect(activationRequiresNewPermissionPrompt()).toBe(false);
  });

  it("settings modules do not call Notification or geolocation APIs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      "arming.ts",
      "presets.ts",
      "exposure.ts",
      "consent.ts",
      "rehearsal.ts",
      "codes.ts",
      "import-export.ts",
      "export-preview.ts",
      "status-view.ts",
      "status.ts",
      "a11y.ts",
      "fixture-catalog.ts",
    ];
    // Split needles so this test file itself is not a false positive source.
    const forbidden = [
      ["Notification", ".requestPermission("],
      ["navigator", ".geolocation."],
      ["mediaDevices", ".getUserMedia("],
      ["permissions", ".query("],
    ] as const;
    for (const file of files) {
      const src = readFileSync(join(here, file), "utf8");
      for (const [a, b] of forbidden) {
        const hit = src.includes(a + b);
        expect(hit, `${file} must not contain ${a}${b}`).toBe(false);
      }
    }
  });
});
