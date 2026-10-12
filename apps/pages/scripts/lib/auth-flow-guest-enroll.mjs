import {
  enterEnrollmentCode,
  expectRefusedOnField,
  readSeed,
} from "./auth-flow-enroll.mjs";
import { guestSetPinKey } from "./auth-flow-guest-pin.mjs";
import { totp } from "./totp.mjs";

export async function guestEnrollMfa(page, { check, snap, PIN }) {
  const security = await snap(page, "1-guest-security");
  check(
    /Authenticator app/.test(security),
    "authenticator row present for a guest",
  );
  check(
    (await page.locator(".sw--method input").count()) === 0,
    "no row holds an input — the list is read-only state",
  );
  const recoveryRow = page.locator(".sw--method", {
    hasText: "Recovery codes",
  });
  const { dialog, totpRow } = await guestSetPinKey(page, { check, snap, PIN });
  const secret = await readSeed(page, check);
  await dialog.getByRole("button", { name: "I scanned it" }).click();
  await page.waitForTimeout(300);
  await enterEnrollmentCode(page, "000000");
  await page.waitForTimeout(800);
  const refused = await snap(page, "1-guest-wrong-enroll-code");
  await expectRefusedOnField(page, check);
  check(
    /3 · Confirm/.test(refused) && (await dialog.count()) === 1,
    "still in the sheet, on Confirm, after a wrong code",
  );
  await enterEnrollmentCode(page, totp(secret));
  await page.waitForTimeout(1500);
  const on = await snap(page, "1-guest-mfa-on");
  check(/Authenticator on/.test(on), "authenticator on after a matching code");
  check(
    /Recovery codes · shown once/.test(on) &&
      (await dialog.locator(".codes li").count()) === 10,
    "ten recovery codes are handed over once",
  );
  await dialog.getByRole("button", { name: "I saved them" }).click();
  await page.waitForTimeout(500);
  await snap(page, "1-guest-security-after");
  check((await page.getByRole("dialog").count()) === 0, "the sheet closed");
  check(
    (await totpRow.getByRole("button", { name: "Remove" }).count()) === 1 &&
      (await totpRow.getByRole("img", { name: "On" }).count()) === 1,
    "the row reports the authenticator on, with Remove as its one action",
  );
  check(
    (await recoveryRow.getByRole("img", { name: "Made" }).count()) === 1,
    "the Recovery row reports codes",
  );
}
