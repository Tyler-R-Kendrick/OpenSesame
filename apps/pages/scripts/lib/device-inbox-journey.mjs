/**
 * The walk behind `verify-device-inbox.mjs` (ADR 0162): a vault with no Identity
 * API and no Host, a request raised and waiting, the person told in another
 * tab, the decision made with the keyboard and the passkey, and the receipts
 * that decision leaves, at one width.
 *
 * Two tabs of one origin do the work: the person's, in front, and a second
 * that is in the background. A headless tab is never hidden, so the second is
 * told it is (`document.hidden` reads true there) and every tab's
 * `Notification` is recorded rather than shown; both are stated here because
 * they are the one thing the harness stands in for.
 */

import { unlockVault } from "./choose-capabilities.mjs";
import {
  hostChunk,
  lockedAgain,
  lockedDevice,
  planeAnswers,
} from "./device-inbox-plane.mjs";
import { applicationSignIn } from "./device-inbox-signin.mjs";
import {
  BASE,
  ORIGIN,
  PATIENCE,
  accessCollection,
  asked,
  bell,
  clickNotification,
  expectFocusLanded,
  notified,
  openInboxRecord,
  openTab,
  press,
  raiseRequest,
  receipts,
  tabAndEnter,
} from "./device-inbox-tabs.mjs";
import {
  accessWorkspace,
  tabToAccessControl,
} from "./local-access-journey.mjs";
import { openRequest } from "./local-request-journey.mjs";
import { expect } from "./patient-expect.mjs";

export const INBOX_CAPABILITIES = [
  "Access authority",
  "Browser-local IAM",
  "Local notifications",
];

const REASON = "Browser request approval proof";

/** A tab of Access by its address: the query a link carries, or the path a tab press leaves. */
const onView = (name) => new RegExp(`(view=|/access/)${name}`);

/** The person's own words for each decision, as Receipts says them. */
const RAISED = "Request raised · Test application";
const APPROVED = "Request approved · Test application";
const DENIED = "Request denied · Test application";
const WITHDRAWN = "Request withdrawn · Test application";

/** Arriving, and sitting at the panel, asks the browser for nothing. */
async function asksNothingAtLoad(t) {
  for (const tab of [t.main, t.background]) {
    expect(await asked(tab), "nothing asked for permission at load").toEqual(
      [],
    );
    expect(
      await tab.evaluate(() => Notification.permission),
      "the permission is the browser's default until the person says",
    ).toBe("default");
  }
}

/**
 * The person turns the system doorbell on. Permission is granted at the press
 * that asks for it, and not before: it is that press, and no other, that asks.
 */
async function allowSystemNotifications(t) {
  const { main, context } = t;
  await main.goto(`${BASE}/settings/capabilities`);
  await unlockVault(main);
  const allow = main.getByRole("button", {
    name: "Allow system notifications",
  });
  await expect(allow).toBeVisible({ timeout: PATIENCE });
  expect(await asked(main), "arriving at the panel asks nothing").toEqual([]);
  await context.grantPermissions(["notifications"], { origin: ORIGIN });
  await press(main, allow);
  await expect(
    main.getByRole("button", { name: "Turn off system notifications" }),
  ).toBeVisible({ timeout: PATIENCE });
  expect(await asked(main), "the key asked, once").toHaveLength(1);
  await main.goto(`${BASE}/access?view=requests`);
  await unlockVault(main);
  await expect(main.getByLabel("Password", { exact: true })).toHaveCount(0, {
    timeout: PATIENCE,
  });
}

/** B. A request is raised in front; the background tab is told, and says only that. */
async function raisedAndTold(t) {
  const { main, background, panel, width } = t;
  await expect
    .poll(() => main.title(), { timeout: PATIENCE })
    .not.toMatch(/^\(\d+\)/);
  await expect(bell(background, width)).toHaveCount(0);
  await raiseRequest(main, panel, REASON);
  await expect(panel.getByRole("treeitem")).toHaveCount(1);
  await expect
    .poll(() => main.title(), { timeout: PATIENCE })
    .toMatch(/^\(1\) /);
  await expect
    .poll(() => background.title(), { timeout: PATIENCE })
    .toMatch(/^\(1\) /);
  await expect(bell(background, width)).toHaveCount(1);
  await expect
    .poll(async () => (await notified(background)).length, {
      timeout: PATIENCE,
    })
    .toBe(1);
  const [ring] = await notified(background);
  expect(ring.title).toBe("Request waiting");
  expect(ring.body).toBe("A request is waiting for you.");
  expect(Object.keys(ring.data ?? {}).sort()).toEqual([
    "action",
    "kind",
    "ref",
  ]);
  expect(JSON.stringify(ring)).not.toMatch(
    /Test application|records:read|rp\.example|Browser request|openid/,
  );
  expect(await notified(main), "the tab in front rings no doorbell").toEqual(
    [],
  );
  expect(await asked(background), "ringing asks for nothing").toEqual([]);
}

/** B2. A click on the notification, and the bell's key, each leave focus on the list. */
async function arrivedFromTheDoorbell(t) {
  const { background, width } = t;
  await clickNotification(background);
  await expect(background).toHaveURL(onView("requests"));
  await expectFocusLanded(background, "a click on the notification");
  // From elsewhere in the page, then by the bell.
  await accessCollection(background, "sessions", "local-sessions");
  await expect(background).toHaveURL(onView("sessions"));
  await bell(background, width).first().click();
  // A phone has no strip: its bell is a row of the More sheet.
  if (width < 900)
    await background.getByRole("button", { name: /^Notifications/ }).click();
  await background.getByRole("button", { name: "Review requests" }).click();
  await expect(background).toHaveURL(onView("requests"));
  await expectFocusLanded(background, "the bell's key");
}

/** C. Approved with the keyboard and the passkey: the marks go, a receipt stays. */
async function approvedAndReceipted(t) {
  const { main, background, panel, width } = t;
  await openRequest(main, REASON);
  await tabToAccessControl(main, panel.getByLabel("Approving person"));
  await expect(panel.getByLabel("Approving person")).toBeFocused();
  await tabAndEnter(
    main,
    panel.getByRole("button", { name: "Approve with passkey", exact: true }),
  );
  await expect(
    panel.getByText(
      "Request approved; awaiting single-use consumption by its requester.",
    ),
  ).toHaveText(
    "Request approved; awaiting single-use consumption by its requester.",
    { timeout: PATIENCE },
  );
  await openRequest(main, REASON, "approved");
  await expect
    .poll(() => main.title(), { timeout: PATIENCE })
    .not.toMatch(/^\(\d+\)/);
  await expect
    .poll(() => background.title(), { timeout: PATIENCE })
    .not.toMatch(/^\(\d+\)/);
  await expect(bell(background, width)).toHaveCount(0);
  const list = await receipts(main, width);
  await expect(list).toContainText(APPROVED);
  await expect(list).toContainText(RAISED);
}

/** D. Withdrawn, then a second request refused with the keyboard. */
async function withdrawnAndDenied(t) {
  const { main, background, panel, width } = t;
  await accessCollection(main, "requests", "local-requests");
  await openRequest(main, REASON, "approved");
  await press(main, panel.getByRole("button", { name: "Withdraw request" }));
  await press(main, panel.getByRole("button", { name: "Confirm withdrawal" }));
  await expect(panel.getByText("Request withdrawn.")).toHaveText(
    "Request withdrawn.",
    {
      timeout: PATIENCE,
    },
  );
  await openRequest(main, REASON, "revoked");
  await raiseRequest(main, panel, "Deny this request");
  await expect
    .poll(async () => (await notified(background)).length, {
      timeout: PATIENCE,
    })
    .toBe(2);
  await openRequest(main, "Deny this request");
  await tabToAccessControl(main, panel.getByLabel("Approving person"));
  await expect(panel.getByLabel("Approving person")).toBeFocused();
  await tabAndEnter(
    main,
    panel.getByRole("button", { name: "Deny with passkey" }),
  );
  await expect(panel.getByText("Request denied.", { exact: true })).toHaveText(
    "Request denied.",
    { timeout: PATIENCE },
  );
  await openRequest(main, "Deny this request", "denied");
  const list = await receipts(main, width);
  await expect(list).toContainText(WITHDRAWN);
  await expect(list).toContainText(DENIED);
  const denied = list.getByRole("treeitem", {
    name: /^Request denied · Test application/,
  });
  await openInboxRecord(main, denied);
  await expect(
    panel.getByRole("img", { name: "denied", exact: true }),
  ).toBeVisible();
  await receipts(main, width);
}

export async function deviceInboxJourney({ width, rig }) {
  const {
    page: rp,
    context,
    credentials,
  } = await rig.seedJourney(false, INBOX_CAPABILITIES);
  expect(hostChunk(), "the device host is its own chunk").toBeDefined();
  await lockedDevice(context, width);
  // The second tab: in the background, and it hears what the first does.
  const background = await openTab(context, width, "sessions", {
    background: true,
  });
  const main = await openTab(context, width, "requests");
  const mainDevice = await rig.authenticator(main, credentials);
  const panel = accessWorkspace(main);
  const t = {
    main,
    background,
    panel,
    width,
    rp,
    context,
    mainDevice,
    rig,
  };
  await asksNothingAtLoad(t);
  await allowSystemNotifications(t);
  await raisedAndTold(t);
  await arrivedFromTheDoorbell(t);
  await approvedAndReceipted(t);
  await withdrawnAndDenied(t);
  await applicationSignIn(t);
  await lockedAgain(main, await planeAnswers(main));
  await context.close();
  console.log(
    `PASS ${width}px device inbox: a request is shown on the tab and told to a second tab without a service, approved and refused with the keyboard and the passkey, and every decision is a receipt; a locked device shows nothing and answers 423`,
  );
}
