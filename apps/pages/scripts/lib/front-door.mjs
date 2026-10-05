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
  // A cold load is still booting (the worker may reload it once): a count taken
  // before the first screen draws would read "no door" and walk past it.
  await setUp
    .or(page.getByRole("heading", { level: 1, name: "Sign in" }))
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  if ((await setUp.count()) === 0) return;
  await setUp.click();
  await page.getByRole("button", { name: "Skip all" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .waitFor({ timeout: 15000 });
}
