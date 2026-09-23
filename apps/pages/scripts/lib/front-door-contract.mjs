// The front door and the ceremony behind it (ADR 0115), on the production
// origin: what a device nobody has set up shows first, and what "Set up your
// own" walks through. Split from verify-static-origin.mjs like the other
// contracts so the walk stays one screen per file.

async function count(page, role, name, exact = false) {
  return page.getByRole(role, { name, exact }).count();
}

/** A. The first screen: setup made large, every sign-in road whole. */
export async function checkFrontDoor(page, check, text, base) {
  check(
    (await page
      .getByRole("heading", { level: 1, name: "open-sesame", exact: true })
      .count()) === 1,
    "first screen is the front door, titled by the wordmark",
  );
  check(!/This device is empty/.test(text), "no setup wall");
  check(
    (await count(page, "button", "Join a session")) === 0,
    "join is invite-link only, not a front-door road",
  );
  for (const [name, label] of [
    ["Set up your own", "setup road on the front door"],
    ["Continue with Google", "Google button present"],
    ["Skip sign-in and continue as guest", "Skip link present"],
    ["Use without an account", "local-only road present"],
  ]) {
    check((await count(page, "button", name)) === 1, label);
  }
  check(
    (await count(page, "button", "Continue as guest", true)) === 1,
    "guest button present",
  );
  const icon = await page.evaluate(() =>
    document.querySelector('link[rel="icon"]')?.getAttribute("href"),
  );
  check(icon === `${base}icon.svg`, `icon href is base-rooted (${icon})`);
}

/**
 * A2. "Set up your own": the composition ceremony (ADR 0130).
 *
 * A device that has approved nothing opens on one tab, `capabilities`, and
 * on nothing else. The ceremonies for connectors, backups, AI, identity and
 * MFA are contributions their capabilities register, so a household that
 * never chose external connectors is never asked for a directory endpoint —
 * which is the product requirement this walk exists to hold. Skip all still
 * retires the door: sign-in, then plain sign-in (setup behind unlock).
 */
export async function walkSetupCeremony(page, check, snap) {
  await page.getByRole("button", { name: "Set up your own" }).click();
  const onSetup = await snap(page, "A2-setup");
  // Connectors and operator identity providers are always on (ADR 0134),
  // so their tabs are here with nothing chosen; the AI and backup tabs still
  // wait for their features.
  const tabs = (await page.getByRole("tab").allTextContents())
    .map((text) => text.trim().toLowerCase())
    .sort();
  check(
    (await page
      .getByRole("tab", { name: "capabilities", selected: true })
      .count()) === 1 &&
      tabs.join(",") === "capabilities,connectors,identity,mfa",
    `setup opens on the capabilities tab, beside only the always-on tabs (${tabs.join(", ")})`,
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
  check(
    rows === 15,
    `choosing a purpose draws one card per optional capability, none for always-on ones (${rows})`,
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
      (await count(page, "button", "Join a session")) === 0,
    "skip all retires the front door: plain sign-in (setup lives behind unlock)",
  );
}
