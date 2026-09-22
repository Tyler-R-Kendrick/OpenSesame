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
 * A2. "Set up your own": four tabs opening on connectors (so the later tabs
 * can reuse directory endpoints), then the model tab, and Skip all retiring
 * the door — sign-in, then plain sign-in (setup behind unlock). Backups and
 * sync were tabs once; both configured a Host, and ADR 0128 took those
 * surfaces away rather than leave controls with nothing behind them.
 */
export async function walkSetupCeremony(page, check, snap) {
  await page.getByRole("button", { name: "Set up your own" }).click();
  const onSetup = await snap(page, "A2-setup");
  check(
    (await page.getByRole("tab").count()) === 4 &&
      (await page
        .getByRole("tab", { name: "connectors", selected: true })
        .count()) === 1,
    "setup opens on the connectors tab of four (ADR 0114, ADR 0128)",
  );
  check(
    !/Where do backups live\?|Should a code follow the key\?|Who runs the model\?|How do people sign in\?|Which connectors are already authorized\?|What should this vault sync with\?/.test(
      onSetup,
    ),
    "setup ceremony has no question-title subheaders",
  );
  check(
    (await page.getByLabel("Directory endpoint").count()) === 1,
    "connectors tab asks for a directory endpoint",
  );
  await page.getByRole("button", { name: "Next step" }).click();
  const ai = await snap(page, "A2-setup-ai");
  check(
    (await page.getByRole("tab", { name: "ai", selected: true }).count()) === 1,
    "next steps to the model tab",
  );
  await page.getByRole("tab", { name: "identity" }).click();
  await snap(page, "A2-setup-identity");
  check(
    (await page
      .getByRole("tab", { name: "identity", selected: true })
      .count()) === 1,
    "the identity tab opens from the strip",
  );
  await page.getByRole("tab", { name: "mfa" }).click();
  const mfa = await snap(page, "A2-setup-mfa");
  check(
    !/Should a code follow the key\?/.test(mfa) &&
      (await page
        .getByRole("heading", { name: "Authenticator app" })
        .count()) === 1 &&
      (await page.getByRole("heading", { name: "Email code" }).count()) === 1 &&
      (await page.getByRole("heading", { name: "Text message" }).count()) === 1,
    "mfa shows connector group labels and no question subheader",
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
