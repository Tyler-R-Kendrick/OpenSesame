/**
 * Secret fields mount after the Add sheet. The arrival locator can also be
 * stale once React replaces the form, so the key check waits on the live
 * "Connect a model provider" dialog until a password input is attached.
 */
export async function waitForModelProviderSheetKeyField(dialog) {
  await dialog.locator('input[type="password"]').first().waitFor({
    state: "attached",
    timeout: 15_000,
  });
}
