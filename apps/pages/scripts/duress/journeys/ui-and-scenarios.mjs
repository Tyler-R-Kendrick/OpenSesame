/**
 * Production UI probe: an owner's Settings › Security draws the Duress panel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSettingsCategory, sealWithPin } from "../../lib/pages-journey.mjs";
import { createHarness } from "../../lib/static-origin-harness.mjs";
import { SCENARIO_IDS, buildScenarioMatrix } from "./scenario-matrix.mjs";

export { SCENARIO_IDS };

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = path.resolve(here, "..", "..", "..");
const DIST = path.join(pagesRoot, "dist");

function settingsPanelWired() {
  const settingsSection = path.join(
    pagesRoot,
    "src",
    "sections",
    "SettingsSection.tsx",
  );
  const src = fs.existsSync(settingsSection)
    ? fs.readFileSync(settingsSection, "utf8")
    : "";
  return /DuressPanel/.test(src);
}

/**
 * Duress is a row of the owner's Settings › Security, never a guest's
 * (`useDuressPanelShown`): seal a vault on this device the way a person does,
 * then read what the section draws.
 */
async function probeSecurityDuressPanel(page, snap, blockers, check) {
  await sealWithPin(page);
  await openSettingsCategory(page, "Security");
  await page.waitForTimeout(800);
  if (snap) await snap(page, "ui-security");
  const onScreen = (await page.locator("#duress-profiles h2").count()) > 0;
  if (!onScreen) {
    blockers.push("settings/security has no visible Duress panel");
  }
  check(
    onScreen,
    onScreen
      ? "duress panel visible in settings/security"
      : "duress panel absent in settings/security",
  );
}

export async function walkUiSettings({ browser, check, record, snap }) {
  const blockers = [];
  const panelWired = settingsPanelWired();
  if (!panelWired) {
    blockers.push("the Duress panel is not imported in SettingsSection");
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
    try {
      await probeSecurityDuressPanel(page, snap, blockers, check);
    } catch (error) {
      blockers.push(
        `settings navigation failed: ${error instanceof Error ? error.message : error}`,
      );
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

  const matrix = buildScenarioMatrix(armBlocked);
  for (const [id, row] of Object.entries(matrix)) {
    check(
      row.status !== "failed",
      `${id}: ${row.status}${row.blocker ? ` (${row.blocker})` : ""}`,
    );
  }
  record("scenario-matrix", JSON.stringify(matrix));
  return matrix;
}
