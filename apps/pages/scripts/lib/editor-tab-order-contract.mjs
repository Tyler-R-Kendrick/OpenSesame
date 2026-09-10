/** Exercise native Tab order across native and manifest-defined forms. */
export async function checkEditorTabOrder(page, check) {
  await page.getByRole("link", { name: "New item", exact: true }).click();
  await page.getByLabel("Type", { exact: true }).waitFor({ state: "visible" });
  const kinds = await page
    .getByLabel("Type", { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  if (kinds.length === 0) throw new Error("No item types were checked");
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  for (const kind of kinds) {
    await page.getByRole("link", { name: "New item", exact: true }).click();
    if (kind !== "login")
      await page.getByLabel("Type", { exact: true }).selectOption(kind);
    const form = page.locator("form.editor");
    if (kind === "login") {
      for (const [command, label] of [
        ["Add authenticator secret", "Authenticator secret"],
        ["Add notes", "Notes"],
        ["Add custom field", "Field name"],
      ]) {
        check(
          (await form.getByLabel(label, { exact: true }).count()) === 0,
          `${label} is absent before its Add command`,
        );
        await form.getByRole("button", { name: command, exact: true }).click();
        await form
          .getByLabel(label, { exact: true })
          .waitFor({ state: "visible" });
        check(
          await form
            .getByLabel(label, { exact: true })
            .evaluate((node) => node === document.activeElement),
          `${command} reveals and focuses its field`,
        );
      }
    }
    await form.getByLabel("Folder", { exact: true }).focus();
    const controls = form.locator(
      "input:visible, select:visible, textarea:visible, button:enabled:visible, a[href]:visible",
    );
    const count = await controls.count();
    check(
      (await controls.first().getAttribute("aria-label")) === "Folder",
      `${kind}: folder starts the title before the name`,
    );
    check(
      (await controls.nth(count - 2).getAttribute("type")) === "submit",
      `${kind}: save follows all fields`,
    );
    check(
      (await controls.last().getAttribute("aria-label")) === "Cancel",
      `${kind}: cancel ends the form`,
    );
    check(
      (await form.locator("[tabindex]").count()) === 0,
      `${kind}: no artificial tab ordering`,
    );
    for (let index = 0; index < count; index += 1) {
      check(
        await controls
          .nth(index)
          .evaluate((node) => node === document.activeElement),
        `${kind}: Tab reaches control ${index + 1} in document order`,
      );
      await page.keyboard.press("Tab");
    }
    check(
      !(await form.evaluate((node) => node.contains(document.activeElement))),
      `${kind}: Tab leaves after cancel`,
    );
    await form.getByRole("link", { name: "Cancel", exact: true }).click();
  }
}
