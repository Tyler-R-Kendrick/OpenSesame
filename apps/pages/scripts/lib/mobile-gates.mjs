/**
 * The gate screens' share of `verify-mobile.mjs` (ADR 0166): the help key a
 * gate draws, and the setup ceremony's bar that holds it.
 */

/** A gate's help key is drawn, and is a touch target (the audit measures the floor). */
export async function helpKey(page, label, harness) {
  const key = page.getByRole("button", { name: "Support", exact: true });
  await key
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  harness.check((await key.count()) === 1, `${label}: one help key is drawn`);
}

/**
 * The ceremony's bar holds the wordmark, the help key, Close and Skip all: at
 * 320px none of them may be pushed off the edge.
 */
export async function setupCeremony(page, stop, { audit, harness }) {
  const custom = page.getByRole("button", { name: "Custom" }).first();
  if (!(await custom.count())) return;
  await custom.tap();
  await page.getByRole("tablist", { name: "Setup step" }).waitFor();
  await page.waitForTimeout(900);
  await audit(page, stop("setup-ceremony"));
  await helpKey(page, stop("setup-ceremony"), harness);
}

/** The door offers its three roads (ADR 0188) and the guest road. */
export async function doorRoads(page, stop, harness) {
  for (const name of [
    "Set up your own",
    "Join a session",
    "Import a file",
    "Skip sign-in and continue as guest",
  ]) {
    harness.check(
      (await page.getByRole("button", { name }).count()) > 0,
      `${stop("front-door")}: "${name}" is offered`,
    );
  }
}

/** Measure project links only in the already-open unlocked Support sheet. */
export async function projectLinks(page, label, { audit, harness }) {
  await page.getByText("About this project", { exact: true }).tap();
  const links = page.locator(".support__project-links a");
  await links.first().waitFor({ state: "visible" });
  harness.check((await links.count()) === 10, `${label}: ten project links`);
  await audit(page, label);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    harness.check(
      box !== null && box.height >= 44 && box.width >= 44,
      `${label}: ${await link.textContent()} target is at least 44px`,
    );
  }
}

/** A locked gate keeps project navigation behind the vault. */
export async function lockedReload(page, stop, { openTab, audit, harness }) {
  await openTab(page, "Vault");
  const lock = page.getByRole("button", { name: "Lock vault" }).first();
  if (await lock.count()) {
    await lock.tap();
    await page.waitForTimeout(900);
    await audit(page, stop("unlock"));
    harness.check(
      (await page.getByText("About this project", { exact: true }).count()) ===
        0,
      `${stop("unlock")}: project navigation stays behind unlock`,
    );
  }
}
