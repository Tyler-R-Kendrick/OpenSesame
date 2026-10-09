export async function guestSetPinKey(page, { check, snap, PIN }) {
  const totpRow = page.locator(".sw--method", { hasText: "Authenticator app" });
  check(
    (await totpRow.getByRole("button", { name: "Add" }).count()) === 1,
    "Add is offered to a guest (not withheld)",
  );
  await totpRow.getByRole("button", { name: "Add" }).click();
  await page.waitForTimeout(500);
  const dialog = page.getByRole("dialog");
  const stepOne = await snap(page, "1-guest-step1-key");
  check(/1 · Key/.test(stepOne), "the rail starts at Key for a keyless vault");
  check(
    /3 · Confirm/.test(stepOne),
    "three steps announced before any is taken",
  );
  check(
    (await dialog
      .getByRole("img", { name: "Scan to add vault MFA" })
      .count()) === 0,
    "no QR code before a key exists",
  );
  await dialog.getByRole("button", { name: "Use a PIN instead" }).click();
  await page.waitForTimeout(300);
  await dialog.getByLabel("PIN", { exact: true }).fill(PIN);
  await dialog.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await dialog.getByRole("button", { name: "Set PIN" }).click();
  await page.waitForTimeout(3500);
  const stepTwo = await snap(page, "1-guest-step2-scan");
  check(/2 · Scan/.test(stepTwo), "scan follows the key on its own");
  check(
    (await dialog.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "2 · Scan",
    "the rail marks Scan as the current step",
  );
  return { dialog, totpRow };
}
