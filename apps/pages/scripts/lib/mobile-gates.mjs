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
