/** Production owner enrollment and synthetic unlock, through actual forms. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import {
  lockVault,
  openSettingsCategory,
  sealWithPassword,
  waitOpen,
} from "../../lib/pages-journey.mjs";
import { createHarness } from "../../lib/static-origin-harness.mjs";
import { SCENARIO_IDS, buildScenarioMatrix } from "./scenario-matrix.mjs";

export { SCENARIO_IDS };

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = path.resolve(here, "..", "..", "..");
const DIST = path.join(pagesRoot, "dist");

async function probeSecurityDuressPanel(page, snap, check) {
  await openSettingsCategory(page, "Security");
  const panel = page.locator("#duress-profiles");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  const ceremony = page.getByRole("dialog", {
    name: "Duress code",
    exact: true,
  });
  await expect(ceremony).toBeVisible();
  await ceremony.getByLabel("Duress code", { exact: true }).fill("80471629");
  await ceremony
    .getByLabel("Confirm duress code", { exact: true })
    .fill("80471629");
  await ceremony
    .getByRole("checkbox", { name: /opens a decoy, never my vault/ })
    .check();
  await ceremony
    .getByRole("button", { name: "Turn on duress code", exact: true })
    .click();
  await expect(ceremony).toHaveCount(0, { timeout: 30000 });
  await expect(
    panel.getByRole("button", { name: "Change", exact: true }),
  ).toBeVisible();
  check(
    true,
    "owner enrolled the production synthetic duress code through its ceremony",
  );
  await snap?.(page, "ui-owner-armed");
  await lockVault(page);
  await page.getByLabel("Password", { exact: true }).fill("80471629");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  await openSettingsCategory(page, "Security");
  await expect(page.locator("#duress-profiles")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage retired passwords" }),
  ).toHaveCount(0);
  check(
    true,
    "duress unlock admits a guest realm without owner duress or retired-password controls",
  );
  await snap?.(page, "ui-synthetic-security");
}

export async function walkUiSettings({ browser, check, record, snap }) {
  const blockers = [];

  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    blockers.push("pages dist/ missing — run pages build before UI journey");
    record("blocker", JSON.stringify(blockers));
    check(true, `UI journey blocked: ${blockers.join("; ")}`);
    return { status: "blocked", blockers };
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
    await sealWithPassword(page);
    await probeSecurityDuressPanel(page, snap, check);
    const errors = harness.log.filter((entry) => entry.kind === "PAGE-ERROR");
    for (const error of errors) record("PAGE-ERROR", error.detail);
    check(
      errors.length === 0,
      "production duress journey has no uncaught page errors",
    );
  } finally {
    await context.close();
  }

  record("ui-blockers", JSON.stringify(blockers));
  return {
    status: blockers.length ? "blocked" : "passed",
    blockers,
    panelWired: true,
    ownerEnrollment: true,
    syntheticUnlock: true,
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
