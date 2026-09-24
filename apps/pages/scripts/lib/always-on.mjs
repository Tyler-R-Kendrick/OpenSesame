// Always-on capabilities (ADR 0135, 0142), by their catalog title. They are
// in every plan and have no switch and no setup card, so a walk that asks
// for one has nothing to do. Mirrors `catalog-always-on.ts` and
// `catalog-always-on-local.ts`; `always-on.test.mjs` holds them equal.

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
  // Browser-local (ADR 0142).
  "Browser-local IAM",
  "Self-issued OpenID",
  "Sign-in broker for sites",
  "Git remote backup",
]);

/**
 * The switch Settings › Capabilities offers for one optional capability, by
 * its catalog title: a tile's switch in a section with several, or the
 * section's own subheader switch where the capability is its only one. Both
 * carry `data-capability-title`, so a walk never needs to know which.
 */
export function capabilitySwitch(page, title) {
  return page.locator(
    `[role="switch"][data-capability-title=${JSON.stringify(title)}]`,
  );
}

/** The switch, only while it is off — the way in a walk presses. */
export function capabilityOffSwitch(page, title) {
  return page.locator(
    `[role="switch"][aria-checked="false"][data-capability-title=${JSON.stringify(title)}]`,
  );
}

/** The switch, only while it is on — the capability is running. */
export function capabilityOnSwitch(page, title) {
  return page.locator(
    `[role="switch"][aria-checked="true"][data-capability-title=${JSON.stringify(title)}]`,
  );
}

/** Wait for Settings › Capabilities to draw its sections. */
export async function awaitCapabilitySections(page) {
  // The panel may still be arriving; a silent return here would leave the
  // switches missing and the walk failing somewhere that looks unrelated.
  await page
    .locator(".capsections")
    .waitFor({ state: "attached", timeout: 15000 });
}
