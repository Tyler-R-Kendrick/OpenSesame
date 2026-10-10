/**
 * Screenshots and check notes for the 2026-10 checklist walk.
 *
 * The harness serves `dist/`; this only records what a person would see.
 * Step files keep their names (`front-door.png`) so the audit can cite them.
 */

import fs from "node:fs";
import path from "node:path";

export const ORIGIN =
  process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
export const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
export const ARTIFACT_ROOT =
  process.env.VERIFY_CHECKLIST_OUT ??
  "/opt/cursor/artifacts/verification-2026-10";

export function profileDir(name) {
  const dir = path.join(ARTIFACT_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function emptyRecord(walk) {
  return {
    profile: walk.name,
    buildKey: walk.buildKey,
    capabilityProfile: walk.capabilityProfile,
    setupChoice: walk.setupChoice,
    note: walk.note ?? "",
    shots: [],
    checks: [],
    errors: [],
  };
}

/** One viewport (or element) capture. Returns the page's visible text. */
export function createShot(page, dir, record) {
  return async function shot(step, target) {
    await page.waitForTimeout(300);
    const file = path.join(dir, `${step}.png`);
    if (target) await target.screenshot({ path: file });
    else await page.screenshot({ path: file });
    record.shots.push(step);
    return page.evaluate(() => document.body.innerText);
  };
}

export function mark(record, id, ok, detail = "") {
  record.checks.push({ id, ok: Boolean(ok), detail: String(detail) });
}

/** Click a named control when it is on screen. False when it never appears. */
export async function visibleClick(page, role, name, timeout = 12_000) {
  const locator = page.getByRole(role, { name, exact: true });
  const seen = await locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (!seen) return false;
  await locator.click();
  return true;
}

/** Sign-in, the front door, or an open vault — whichever the choice landed on. */
export async function waitPastSetup(page) {
  const signIn = page.getByRole("heading", { level: 1, name: "Sign in" });
  const door = page.getByRole("button", {
    name: "Set up your own",
    exact: true,
  });
  const lock = page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true");
  await signIn.or(door).or(lock).first().waitFor({ timeout: 30_000 });
  if (
    await lock
      .first()
      .isVisible()
      .catch(() => false)
  )
    return "app";
  if (await signIn.isVisible().catch(() => false)) return "sign-in";
  return "door";
}
