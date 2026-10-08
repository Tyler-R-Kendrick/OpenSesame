// The front door's roads, for the browser walks (ADR 0150 §1): a device with
// no vault offers "Set up your own" and "Join a session", with the guest road
// as the card's corner Skip. Sign-in — and its "Use without an account" —
// comes once setup has been answered or skipped.

/** The door's one guest road: the corner Skip. */
export function doorGuest(page) {
  return page.getByRole("button", {
    name: "Skip sign-in and continue as guest",
  });
}

/**
 * Retire the door the way a person who wants sign-in does: Set up your own,
 * then Skip all, which lands on the sign-in screen. A no-op where the door
 * is not showing.
 */
export async function passTheDoor(page) {
  const setUp = page.getByRole("button", { name: "Set up your own" });
  const signIn = page.getByRole("heading", { level: 1, name: "Sign in" });
  // A newly opened page can reach network idle before React paints the door.
  await setUp.or(signIn).first().waitFor({ state: "visible", timeout: 15000 });
  if ((await setUp.count()) === 0) return;
  await setUp.click();
  await page.getByRole("button", { name: "Skip all" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .waitFor({ timeout: 15000 });
}

/**
 * A later tab, and a reload, land on the keyless guest tomb this walk
 * already opened. Unlock resumes that tomb. "Skip to the guest vault" is
 * drawn only beside a sealed vault that is not that tomb, so a click that
 * waits for it alone times out. The front door's Skip remains the first entry.
 */
export async function openGuestAgain(page) {
  const skip = page.getByRole("button", { name: "Skip to the guest vault" });
  const resume = page.getByRole("button", { name: "Unlock", exact: true });
  const door = doorGuest(page);
  await skip.or(resume).or(door).first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
  if (await door.isVisible()) await door.click();
  else if (await skip.isVisible()) await skip.click();
  else await resume.click();
}
