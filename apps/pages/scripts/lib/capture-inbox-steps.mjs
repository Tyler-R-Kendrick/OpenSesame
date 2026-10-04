/**
 * Capture verbs for the device's receipts, inbox and local notifications
 * (ADR 0162): a vault with a person, an organization and a registered
 * application, a request raised in the tab in front, and a second tab in the
 * background that is told about it.
 *
 * The same steps walk the base build and the branch, so a base that has not
 * grown the inbox gives the honest "before": the request is raised, nothing
 * says it waits, the second tab stays quiet and Receipts has no trail.
 * `inboxView` points the journey's `shot` at either tab.
 *
 * A headless tab is never hidden, so the second tab is told it is
 * (`document.hidden` reads true there) and its `Notification` is recorded
 * rather than shown. That is the one thing the harness stands in for.
 */

import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { awaitCapabilitySections, capabilitySwitch } from "./always-on.mjs";
import { views } from "./capture-live-join-steps.mjs";
import { chooseCapabilities, unlockVault } from "./choose-capabilities.mjs";
import {
  bell,
  notified,
  openTab,
  press,
  raiseRequest,
  tabAndEnter,
} from "./device-inbox-journey.mjs";
import { authenticator, bundle } from "./local-iam-rig.mjs";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/local-iam.ts", import.meta.url),
);

/** The two tabs of one journey, per the page the capture loop owns. */
const tabs = new WeakMap();

let fixture;

/** Seed the vault in a disposable page of the screen's own context. */
async function seedVault(page, origin) {
  const context = page.context();
  fixture ??= await bundle(FIXTURE, "LocalIamFixture");
  // Wall time frozen, so both builds' timestamps read the same.
  await context.clock.setFixedTime(new Date("2026-09-10T00:00:00Z"));
  await context.route(`${origin}/fixture`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Disposable IAM fixture</body></html>",
    }),
  );
  const seat = await context.newPage();
  await seat.goto(`${origin}/fixture`);
  const device = await authenticator(seat);
  await seat.addScriptTag({ content: fixture });
  await seat.evaluate(() => LocalIamFixture.seed());
  const { credentials } = await device.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: device.authenticatorId,
  });
  await seat.close();
  return credentials;
}

/**
 * Choose a capability this build has. A base that has not grown one has no
 * switch for it, which is a legitimate difference and not a miss.
 */
async function chooseIfOffered(context, width, title, base) {
  const probe = await context.newPage();
  await probe.setViewportSize({ width, height: 900 });
  await probe.goto(`${base}/settings/capabilities`);
  await unlockVault(probe);
  await awaitCapabilitySections(probe);
  const offered = (await capabilitySwitch(probe, title).count()) > 0;
  await probe.close();
  if (offered) await chooseCapabilities(context, width, [title], base);
  return offered;
}

/** What each tab says, read from the browser. */
async function reportTabs({ main, background, width }) {
  const marks = await main
    .locator("[role=img][aria-label]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  const rings = await notified(background);
  console.log(`  inbox: front tab marks: ${marks.join(" | ") || "none"}`);
  console.log(`  inbox: background title: ${await background.title()}`);
  console.log(
    `  inbox: background bell: ${await bell(background, width).count()}`,
  );
  console.log(`  inbox: background system notifications: ${rings.length}`);
  for (const ring of rings)
    console.log(
      `  inbox: ring ${JSON.stringify({ title: ring.title, body: ring.body, data: ring.data })}`,
    );
}

/** Seed the vault, choose what this build offers, and open the two tabs. */
async function seed(page, { origin, site }, { capabilities, optional = [] }) {
  const context = page.context();
  const { width } = page.viewportSize();
  const credentials = await seedVault(page, origin);
  await context.grantPermissions(["notifications"], { origin });
  await chooseCapabilities(context, width, capabilities, site);
  const chosen = [];
  for (const title of optional)
    chosen.push(await chooseIfOffered(context, width, title, site));
  // Front: Requests. Behind it: Sessions, told it is in the background.
  const background = await openTab(context, width, "sessions", {
    background: true,
  });
  const main = await openTab(context, width, "requests");
  await authenticator(main, credentials);
  const panel = main.getByRole("region", {
    name: "Local requests",
    exact: true,
  });
  tabs.set(page, { main, background, panel, width });
  views.set(page, main);
  console.log(
    `  inboxSeed: optional capabilities offered: ${chosen.join(",") || "none"}`,
  );
}

/** Raise a request in the tab in front, with the keyboard. */
async function raise({ main, panel }, reason) {
  await raiseRequest(main, panel, reason);
  // Long enough for the other tab to hear it and for its poll to settle.
  await main.waitForTimeout(2500);
}

/** Open the bell (the phone's More key, then its Notifications row). */
async function openBell({ background, width }) {
  const key = bell(background, width).first();
  const phone = width < 900;
  if (await key.count()) {
    await key.click();
    const row = background.getByRole("button", { name: /^Notifications/ });
    if (phone && (await row.count())) await row.click();
  } else if (phone) {
    await background.getByRole("button", { name: "More" }).first().click();
  }
  await background.waitForTimeout(700);
}

/** Approve the waiting request with the keyboard and the passkey. */
async function approve({ main, panel }) {
  const review = panel.getByRole("button", {
    name: "Review request",
    exact: true,
  });
  await press(main, review.first());
  await tabAndEnter(
    main,
    panel.getByRole("button", { name: "Approve with passkey", exact: true }),
  );
  await expect(panel.getByText(/Request approved/)).toBeVisible();
  await main.waitForTimeout(1500);
}

const bringToTop = (heading) =>
  heading.evaluate((node) => {
    node.scrollIntoView({ block: "start", behavior: "instant" });
  });

/** Open Settings › Capabilities in the front tab, at its notification section. */
async function capabilities({ main, width }, site) {
  await main.goto(`${site}/settings/capabilities`);
  await unlockVault(main);
  await awaitCapabilitySections(main);
  const local = main.getByRole("heading", { name: /^Local notifications/i });
  const heading = (await local.count())
    ? local
    : main.getByRole("heading", { name: /^Notifications/i });
  await bringToTop(heading.first());
  const names = await main
    .locator(".capsections h2, .capsections h3")
    .allInnerTexts();
  console.log(
    `  inboxCapabilities (${width}px): sections ${names.join(" | ")}`,
  );
  await main.waitForTimeout(600);
}

/** Bring a heading of the front tab to the top, when it has one. */
async function scroll({ main }, name) {
  const heading = main
    .getByRole("heading", { name: new RegExp(`^${name}`, "i") })
    .first();
  if (!(await heading.count())) return;
  await bringToTop(heading);
  await main.waitForTimeout(600);
}

/** Print what the two tabs say, so a sheet's numbers come from the browser. */
async function report(held) {
  await reportTabs(held);
  const rows = await held.main.locator("#access-receipts li").allInnerTexts();
  console.log(`  inbox: receipts rows: ${rows.length}`);
  for (const row of rows) console.log(`    ${row.replaceAll(/\s+/g, " ")}`);
  const overflow = await held.main.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  console.log(`  inbox: page scrolls sideways: ${overflow}`);
}

export function inboxSteps({ origin, base }) {
  const at = (page) => {
    const held = tabs.get(page);
    if (!held) throw new Error("capture-evidence: inboxSeed comes first");
    return held;
  };
  const site = `${origin}${base.replace(/\/$/, "")}`;
  return {
    inboxSeed: (page, spec) => seed(page, { origin, site }, spec),
    inboxRaise: (page, reason) => raise(at(page), reason),
    inboxBell: (page) => openBell(at(page)),
    inboxApprove: (page) => approve(at(page)),
    inboxCapabilities: (page) => capabilities(at(page), site),
    inboxScroll: (page, name) => scroll(at(page), name),
    inboxReport: (page) => report(at(page)),
    /** Open Access › Sessions in the front tab. */
    async inboxReceipts(page) {
      const { main } = at(page);
      await press(main, main.getByRole("tab", { name: /^Sessions/ }));
      await main.waitForTimeout(1200);
    },
    /** Point `shot` at the front tab or the background one. */
    async inboxView(page, which) {
      const { main, background } = at(page);
      const shown = which === "background" ? background : main;
      // A tab behind another never paints, so it cannot be photographed.
      await shown.bringToFront();
      views.set(page, shown);
    },
  };
}
