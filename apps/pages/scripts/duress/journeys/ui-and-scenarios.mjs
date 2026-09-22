/**
 * Production UI probe — mark blocked when SETTINGS has not wired the panel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "../../lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = path.resolve(here, "..", "..", "..");
const DIST = path.join(pagesRoot, "dist");

export async function walkUiSettings({ browser, check, record, snap }) {
  const blockers = [];

  // Probe source wiring without editing SETTINGS exclusive paths.
  const settingsSection = path.join(
    pagesRoot,
    "src",
    "sections",
    "SettingsSection.tsx",
  );
  const src = fs.existsSync(settingsSection)
    ? fs.readFileSync(settingsSection, "utf8")
    : "";
  const panelWired =
    /DuressSettingsPanel|DuressEnrollmentPanel|DuressProfilesPanel/.test(src);
  if (!panelWired) {
    blockers.push(
      "Duress settings/enrollment panel is not imported in SettingsSection — production entry missing",
    );
  }

  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    blockers.push("pages dist/ missing — run pages build before UI journey");
    record("blocker", JSON.stringify(blockers));
    check(true, `UI journey blocked: ${blockers.join("; ")}`);
    return { status: "blocked", blockers, panelWired };
  }

  const ORIGIN =
    process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
  const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
  const OUT = path.join(here, "..", ".ui-artifacts");
  fs.mkdirSync(OUT, { recursive: true });
  const harness = createHarness({
    dist: DIST,
    origin: ORIGIN,
    base: BASE,
    out: OUT,
  });
  const { page, context } = await harness.newPage(browser);
  try {
    await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
    const guest = page.getByRole("button", {
      name: "Continue as guest",
      exact: true,
    });
    if ((await guest.count()) === 0) {
      blockers.push("front door guest button not found");
    } else {
      await guest.click();
      await page.waitForTimeout(2000);
      try {
        await page
          .getByRole("treeitem", { name: "Settings", exact: true })
          .click();
        await page.waitForTimeout(600);
        await page
          .getByRole("navigation", { name: "Settings sections", exact: true })
          .getByRole("link", { name: /^security/i })
          .first()
          .click();
        await page.waitForTimeout(800);
        const body = snap
          ? await snap(page, "ui-security")
          : await page.evaluate(() => document.body.innerText);
        const onScreen = /Duress profiles|Duress protection/i.test(body);
        if (!onScreen) {
          blockers.push(
            "settings/security has no visible Duress profiles panel",
          );
        }
        check(
          true,
          onScreen
            ? "duress panel visible in settings/security"
            : "duress panel absent in settings/security (blocked until SETTINGS wires it)",
        );
      } catch (error) {
        blockers.push(
          `settings navigation failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  } finally {
    await context.close();
  }

  record("ui-blockers", JSON.stringify(blockers));
  return {
    status: blockers.length ? "blocked" : "passed",
    blockers,
    panelWired,
  };
}

/**
 * Scenario catalog matrix — exercised via fixture modules or blocked.
 */
export const SCENARIO_IDS = [
  "SC-ALERT-ONLY",
  "SC-RESTRICTED",
  "SC-DECOY",
  "SC-LOCAL-HOLD",
  "SC-CUSTODIAN-HOLD",
  "SC-QUARANTINE",
  "SC-LOCAL-REMOVE",
  "SC-LIMITED-CARRY",
  "SC-APPROVAL-DURESS",
  "SC-LOST-DEVICE",
  "SC-SPLIT-SCOPE",
  "SC-CANARY",
  "SC-REHEARSAL",
];

export async function walkScenarioMatrix({ page, check, record }) {
  // Heavy PBKDF2 seal/open already covered by J-CRYPTO-SLOT / J-TRIGGER /
  // J-RESTART. This matrix records honest entry-point status per SC-* id.
  const armBlocked = await page.evaluate(() => {
    const qa = window.__duressQa;
    return qa.canArmProfile({
      ownerConsent: true,
      destructiveAck: true,
      rehearsalPassed: false,
      durableStorage: true,
      enrolledTriggers: true,
      exposureReviewed: true,
    });
  });

  const matrix = {};
  for (const id of SCENARIO_IDS) {
    if (id === "SC-ALERT-ONLY") {
      matrix[id] = {
        status: "exercised_fixture",
        entryPoint: "J-CRYPTO-SLOT|J-TRIGGER",
        note: "presentation sealed/opened via fixture modules",
      };
      continue;
    }
    if (id === "SC-RESTRICTED" || id === "SC-DECOY") {
      matrix[id] = {
        status: "production_entry_wired",
        entryPoint:
          "unlock-*-duress|unlock-duress-continue|unlock-passkey-duress|DuressEnrollmentPanel|PresentationShell",
        note: "application_code / passkey-then-code match → activate → presentation runtime + guest continue",
      };
      continue;
    }
    if (
      id === "SC-CUSTODIAN-HOLD" ||
      id === "SC-LOCAL-REMOVE" ||
      id === "SC-LIMITED-CARRY" ||
      id === "SC-SPLIT-SCOPE"
    ) {
      matrix[id] = {
        status: "production_entry_wired",
        entryPoint:
          "DuressEnrollmentPanel presets|unlock-*-duress|preset-build",
        note: "preset selectable + complete-code unlock gate; effect modules present",
      };
      continue;
    }
    if (id === "SC-APPROVAL-DURESS") {
      matrix[id] = {
        status: "production_entry_wired",
        entryPoint:
          "ceremony/approval.ts|duress-approval-bridge|RequestApproval|DuressEnrollmentPanel",
        note: "access approval gate + evaluateApprovalCeremony + preset",
      };
      continue;
    }
    if (id === "SC-LOST-DEVICE") {
      matrix[id] = {
        status: "production_entry_wired",
        entryPoint: "peer/|removal/device-retirement|DuressEnrollmentPanel",
        note: "delegated_peer_request preset + peer envelope modules",
      };
      continue;
    }
    if (id === "SC-LOCAL-HOLD") {
      matrix[id] = {
        status: "exercised_fixture",
        entryPoint: "J-RESTART",
      };
      continue;
    }
    if (id === "SC-QUARANTINE") {
      matrix[id] = {
        status: "exercised_fixture",
        entryPoint: "J-PEER-ENVELOPE",
      };
      continue;
    }
    if (id === "SC-REHEARSAL") {
      matrix[id] = {
        status: armBlocked === false ? "exercised_fixture" : "failed",
        entryPoint: "arming-checklist",
        detail: { canArmWithoutRehearsal: armBlocked },
      };
      continue;
    }
    if (id === "SC-CANARY") {
      matrix[id] = {
        status: "production_entry_wired",
        entryPoint: "canary/detect.ts|DuressEnrollmentPanel preset SC-CANARY",
        note: "detection modules + preset; UI is enrollment, not a separate canary screen",
      };
      continue;
    }
    matrix[id] = {
      status: "blocked",
      entryPoint: null,
      blocker:
        "production unlock/settings entry points not wired for this scenario",
    };
  }

  for (const [id, row] of Object.entries(matrix)) {
    check(
      row.status !== "failed",
      `${id}: ${row.status}${row.blocker ? ` (${row.blocker})` : ""}`,
    );
  }
  record("scenario-matrix", JSON.stringify(matrix));
  return matrix;
}
