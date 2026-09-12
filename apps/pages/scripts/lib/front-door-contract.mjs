// The front door and the ceremony behind it (ADR 0115), on the production
// origin: what a device nobody has set up shows first, and what "Set up your
// own" walks through. Split from verify-static-origin.mjs like the other
// contracts so the walk stays one screen per file.

async function count(page, role, name, exact = false) {
  return page.getByRole(role, { name, exact }).count();
}

/** A. The first screen: the two roads made large, every sign-in road whole. */
export async function checkFrontDoor(page, check, text, base) {
  check(
    (await page
      .getByRole("heading", { level: 1, name: "open-sesame", exact: true })
      .count()) === 1,
    "first screen is the front door, titled by the wordmark",
  );
  check(!/This device is empty/.test(text), "no setup wall");
  for (const [name, label] of [
    ["Join a session", "join road on the front door"],
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
 * A2. "Set up your own": six tabs opening on backups, connectors second and
 * asking for a directory, the identity tab keeping its question, and Skip
 * all retiring the door — sign-in, with both roads back in its foot.
 */
export async function walkSetupCeremony(page, check, snap) {
  await page.getByRole("button", { name: "Set up your own" }).click();
  const onSetup = await snap(page, "A2-setup");
  check(
    (await page.getByRole("tab").count()) === 6 &&
      /Where do backups live\?/.test(onSetup),
    "setup opens on the backups tab of six (ADR 0114, ADR 0115)",
  );
  await page.getByRole("button", { name: "Next" }).click();
  const connectors = await snap(page, "A2-setup-connectors");
  check(
    /Which connectors are already authorized\?/.test(connectors) &&
      (await page.getByLabel("Directory endpoint").count()) === 1,
    "next browses to connectors, which asks for a directory endpoint",
  );
  await page.getByRole("button", { name: "Next" }).click();
  const ai = await snap(page, "A2-setup-ai");
  check(/Who runs the model\?/.test(ai), "next browses to ai");
  await page.getByRole("tab", { name: "identity" }).click();
  const identity = await snap(page, "A2-setup-identity");
  check(
    /How do people sign in\?/.test(identity),
    "the identity tab keeps the one question",
  );
  await page.getByRole("button", { name: "Skip all" }).click();
  const back = await snap(page, "A2-back");
  check(
    /^Sign in$/m.test(back) &&
      (await count(page, "button", "Deployment setup")) === 1 &&
      (await count(page, "button", "Join a session")) === 1,
    "skip all retires the front door: sign-in, with both roads in its foot",
  );
}
