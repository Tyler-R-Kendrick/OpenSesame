/**
 * J-NAV: record a key on Settings › Keybindings, command-bar setting search,
 * the same key on keybindings/config.yaml's page, the key survives a reload.
 * Settings › General does not pin an approvals view.
 */
import {
  lockVault,
  openConfigFile,
  openConfigForm,
  openGeneral,
  runCommand,
  sealWithPassword,
  unlockWithPassword,
} from "./pages-journey.mjs";

/** The Keybindings tab, reached the way a person reaches it. */
async function openKeybindings(page) {
  await openGeneral(page);
  await openConfigForm(page, "Keybindings");
  await page
    .getByRole("heading", { name: "Keymap" })
    .waitFor({ timeout: 8000 });
}

/**
 * The recording hairline is the only sign the keymap timeout is running, and
 * the global reduced-motion rule forces every animation to 0.01ms. Under
 * reduced motion it must still last the timeout, in steps, not vanish while
 * the timer keeps counting (computed style, not the stylesheet's text).
 */
async function reducedMotionCountdown(page, check) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Add a key for Next row" }).click();
  await page.keyboard.press("x");
  const drain = page.locator(".kb-capture__drain");
  await drain.waitFor({ timeout: 8000 });
  const read = () =>
    drain.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        duration: style.animationDuration,
        timing: style.animationTimingFunction,
        transform: style.transform,
      };
    });
  const early = await read();
  check(
    early.duration === "1s",
    `reduced motion keeps the countdown at the keymap timeout (${early.duration})`,
  );
  check(
    /^steps\(4/.test(early.timing),
    `reduced motion steps the countdown (${early.timing})`,
  );
  await page.waitForTimeout(300);
  const later = await read();
  const scaleX = Number(/matrix\(([^,]+),/.exec(later.transform)?.[1] ?? "NaN");
  check(
    scaleX > 0 && scaleX < 1,
    `the countdown is still draining after 300ms (${later.transform})`,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.keyboard.press("Escape");
  await drain.waitFor({ state: "detached", timeout: 8000 });
}

export async function walkJNav({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  // Pending approvals are an Access › Requests concern, not a setting.
  check(
    (await page.getByLabel("Pin approvals view").count()) === 0,
    "Settings › General carries no approvals view",
  );
  await openKeybindings(page);
  await reducedMotionCountdown(page, check);
  // Record `w` for Next row by pressing it, the way a person does: the field
  // keeps the key once the keymap's own timeout lapses.
  await page.getByRole("button", { name: "Add a key for Next row" }).click();
  await page.keyboard.press("w");
  await page
    .getByRole("button", { name: "Change w for Next row" })
    .waitFor({ timeout: 8000 });
  check(
    (await page
      .getByRole("button", { name: "Change w for Next row" })
      .count()) === 1,
    "the recorded key is drawn as one keycap on Next row",
  );
  const opened = await runCommand(page, "autoLockMinutes");
  check(
    /Opened autoLockMinutes/i.test(opened),
    `palette reaches setting: ${opened}`,
  );
  // The file's view is the page: its address draws the keymap, with the key.
  await openConfigFile(page, "keybindings");
  await page
    .getByRole("button", { name: "Change w for Next row" })
    .waitFor({ timeout: 8000 });
  check(
    (await page
      .getByRole("button", { name: "Change w for Next row" })
      .count()) === 1,
    "the recorded key is drawn on keybindings/config.yaml's page",
  );
  await snap(page, "J-NAV-config");
  await lockVault(page);
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPassword(page);
  await openKeybindings(page);
  check(
    (await page
      .getByRole("button", { name: "Change w for Next row" })
      .count()) === 1,
    "the recorded key survived unlock/reload",
  );
}
