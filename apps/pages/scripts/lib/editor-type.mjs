/**
 * The title row's type segment is a combobox over a closed list (ADR 0181):
 * a click opens it and a row is taken with the pointer, as a person does.
 */
const LIST = '[role="listbox"][aria-label="Type choices"]';

/** The kinds the type segment offers on this installation, in list order. */
export async function listedTypes(page) {
  await page.getByLabel("Type", { exact: true }).click();
  const kinds = await page
    .locator(`${LIST} [role="option"]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-key")));
  await page.keyboard.press("Escape");
  return kinds;
}

/** Choose `kind` from the type segment's list. */
export async function chooseType(page, kind) {
  await page.getByLabel("Type", { exact: true }).click();
  await page.locator(`${LIST} [data-key="${kind}"]`).click();
}
