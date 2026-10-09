// The front door and the ceremony behind it (ADR 0115, ADR 0150), on the production
// origin: what a device nobody has set up shows first, and what "Set up your
// own" walks through. Split from verify-static-origin.mjs like the other
// contracts so the walk stays one screen per file.

import { loadInventory } from "./capability-compose-state.mjs";

/** How many optional capabilities the catalog this build ships declares. */
async function optionalCapabilityCount() {
  const { catalog } = await loadInventory();
  return catalog.capabilities.filter((entry) => entry.tier === "optional")
    .length;
}

async function count(page, role, name, exact = false) {
  return page.getByRole(role, { name, exact }).count();
}

/**
 * A. The first screen: two roads — set up your own, join a session — and
 * the guest road as the corner Skip. No sign-in: a device with no vault has
 * nothing to sign in to (ADR 0150 §1).
 */
export async function checkFrontDoor(page, check, text, base) {
  check(
    (await page
      .getByRole("heading", { level: 1, name: "open-sesame", exact: true })
      .count()) === 1,
    "first screen is the front door, titled by the wordmark",
  );
  check(!/This device is empty/.test(text), "no setup wall");
  for (const [name, label] of [
    ["Set up your own", "setup road on the front door"],
    [
      "Join a session",
      "join road on the front door, even on the shared origin (ADR 0150)",
    ],
    ["Skip sign-in and continue as guest", "Skip link present"],
  ]) {
    check((await count(page, "button", name)) === 1, label);
  }
  for (const [name, label] of [
    ["Continue with Google", "no Google button on the door"],
    ["Continue as guest", "no full-size guest button on the door"],
    ["Use without an account", "no local-only road on the door"],
  ]) {
    check((await count(page, "button", name, true)) === 0, label);
  }
  const icon = await page.evaluate(() =>
    document.querySelector('link[rel="icon"]')?.getAttribute("href"),
  );
  check(icon === `${base}icon.svg`, `icon href is base-rooted (${icon})`);
}

/**
 * A2. "Set up your own": the composition ceremony (ADR 0130).
 *
 * A device that has approved nothing opens on the configuration choice
 * (ADR 0154). Custom enters the one tab, `capabilities`, and nothing else.
 * The ceremonies for connectors, backups, AI, identity and MFA are
 * contributions their capabilities register, so a household that never
 * chose external connectors is never asked for a directory endpoint —
 * which is the product requirement this walk exists to hold. Skip all still
 * retires the door: plain sign-in, and setup lives behind unlock. Join stays
 * on that sign-in, because a setup record does not take the road away.
 */
export async function walkSetupCeremony(page, check, snap) {
  await page.getByRole("button", { name: "Set up your own" }).click();
  const onChoice = await snap(page, "A2-setup-configuration");
  for (const choice of ["Minimal", "Default", "Full", "Custom"]) {
    check(
      (await count(page, "button", choice, true)) === 1,
      `setup offers "${choice}"`,
    );
  }
  check(
    !/How should this installation start\?/.test(onChoice),
    "the configuration choice has no question-title",
  );
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  const onSetup = await snap(page, "A2-setup");
  // Connectors, identity and MFA panels register when those extensions are
  // on (ADR 0153). A fresh device has only the capabilities step.
  const tabs = (await page.getByRole("tab").allTextContents())
    .map((text) => text.trim().toLowerCase())
    .sort();
  check(
    (await page
      .getByRole("tab", { name: "capabilities", selected: true })
      .count()) === 1 && tabs.join(",") === "capabilities",
    `setup opens on the capabilities tab alone (${tabs.join(", ")})`,
  );
  check(
    (await page.getByLabel("Directory endpoint").count()) === 0,
    "no directory endpoint is asked for on the capabilities tab",
  );
  check(
    !/Where do backups live\?|Should a code follow the key\?|Who runs the model\?|How do people sign in\?|Which connectors are already authorized\?|What should this vault sync with\?/.test(
      onSetup,
    ),
    "setup ceremony has no question-title subheaders",
  );
  for (const road of [
    "Use the minimal configuration",
    "Customize this installation",
  ]) {
    check(
      (await count(page, "button", road)) === 1,
      `the ceremony offers "${road}"`,
    );
  }
  check(
    (await count(page, "button", "Join an existing instance")) === 0,
    "the join road is withheld where no operator requires anything",
  );

  await page
    .getByRole("button", { name: /Customize this installation/ })
    .click();
  await snap(page, "A2-setup-purpose");
  const purposes = await page
    .locator(".purpose .preset__name")
    .allTextContents();
  check(
    purposes.join("|") === "Personal|Family|Homelab|Organization|Custom",
    `the purposes are offered in order (${purposes.join(", ")})`,
  );

  await page.getByRole("button", { name: /^Family/ }).click();
  const cards = await snap(page, "A2-setup-cards");
  const rows = await page.locator(".capcards > li").count();
  // One card per optional capability, read from the catalog the build ships,
  // so a capability another branch adds changes this number and not this file.
  // The always-on ones (sharing.drops among them) are not cards.
  const optional = await optionalCapabilityCount();
  check(
    rows === optional,
    `choosing a purpose draws one card per optional capability, none for always-on ones (${rows} of ${optional})`,
  );
  check(
    (await count(page, "button", "Save on this device")) === 1 &&
      !/applied · saved on this device/.test(cards),
    "a purpose is a preview: nothing is applied until it is saved (ADR 0130 consent)",
  );

  await page.getByRole("button", { name: "Skip all" }).click();
  const back = await snap(page, "A2-back");
  check(
    /^Sign in$/m.test(back) &&
      (await count(page, "button", "Deployment setup")) === 0 &&
      (await count(page, "button", "Set up your own")) === 0 &&
      (await count(page, "button", "Join a session")) === 1,
    "skip all retires the front door: plain sign-in keeps join (setup lives behind unlock)",
  );
}
