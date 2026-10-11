/**
 * What the recipient does in Settings › Trusted contacts › Recovery: choose
 * the recovery file, name the device, send the request, paste the answers
 * that come back, open the recovery and take what it protected out of the
 * page by a file or by the vault's own Import sheet.
 */

import { expect } from "./tc-expect.mjs";

export const START = "Start a recovery";

/** The file picker behind the recovery file's key, answered with the owner's file. */
export async function chooseFile(recipient, sheet, { name, body }) {
  const [chooser] = await Promise.all([
    recipient.page.waitForEvent("filechooser"),
    // The hidden input carries the same name; the key is the <button>.
    recipient
      .key("The recovery file", sheet)
      .and(sheet.locator("button"))
      .click(),
  ]);
  await chooser.setFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(body),
  });
}

/**
 * The recovery file read, the device named, the request sent. The file's facts
 * are read off the sheet before the request goes: they come from the owner's
 * signed policy, which is what the recipient is about to rely on.
 */
export async function startRecovery(recipient, { file, device }) {
  await recipient.press(START);
  const sheet = recipient.sheet(START);
  await expect(sheet).toBeVisible();
  await chooseFile(recipient, sheet, file);
  const facts = sheet.locator("dl");
  await expect(facts).toContainText("Owner key");
  const text = (await facts.innerText()).replace(/\s+/g, " ");
  await recipient.type("Name this device", device, sheet);
  await recipient.page.keyboard.press("Enter");
  return { sheet: recipient.sheet(/ recovery$/), facts: text };
}

/** An answer pasted into the sheet and added; what stands is read off its fact line. */
export async function addAnswer(recipient, sheet, answer) {
  await recipient.paste("An approval or a release", answer, sheet);
  await recipient.press("Add", sheet);
}
