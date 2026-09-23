// Always-on capabilities (ADR 0135), by the title Settings › Capabilities
// would have shown them under. They are in every plan and have no row, no
// Add key and no setup card, so a walk that asks for one has nothing to do.
// Mirrors `catalog-always-on.ts`; `always-on.test.mjs` holds the two equal.

export const ALWAYS_ON_TITLES = new Set([
  "Passkey records",
  "Certificate records",
  "Import and export formats",
  "Cloud key services",
  "External connectors",
  "Access authority",
  "Operator identity providers",
  "Ambient single sign-on",
  "Activity log",
  "Guided help",
]);

/**
 * Open Settings › Capabilities › Advanced, where the per-capability rows
 * live. A no-op when it is already open; waits for the panel to render.
 */
export async function openAdvanced(page) {
  const details = page.getByTestId("capabilities-advanced");
  // The panel may still be arriving; a silent return here would leave the
  // rows hidden and the walk failing somewhere that looks unrelated.
  await details.waitFor({ state: "attached", timeout: 15000 });
  if (await details.evaluate((node) => node.open)) return;
  await details.locator("summary").click();
  await page.waitForTimeout(300);
}
