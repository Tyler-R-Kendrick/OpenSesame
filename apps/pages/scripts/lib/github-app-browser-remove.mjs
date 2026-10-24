/** The GitHub App walk's removal, as a person makes it. */
import assert from "node:assert/strict";

/**
 * Removing asks in the page: the first press arms the key, the second
 * removes. A browser dialog would be a regression, so one is counted.
 */
export async function removeAppInPage(page) {
  let dialogs = 0;
  const onDialog = (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  };
  page.on("dialog", onDialog);
  try {
    await page
      .getByRole("button", {
        name: "Remove GitHub App from this device",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: "Confirm removing the GitHub App from this device",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Create GitHub App", exact: true })
      .waitFor();
  } finally {
    page.off("dialog", onDialog);
  }
  assert.equal(dialogs, 0, "Removing the App opened no browser dialog");
}
