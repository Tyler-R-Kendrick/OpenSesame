import { doorGuest } from "./front-door.mjs";

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
