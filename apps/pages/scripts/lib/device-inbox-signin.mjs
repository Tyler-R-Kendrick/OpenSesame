/**
 * The application sign-in leg of `verify-device-inbox.mjs` (ADR 0162): an
 * application signs in through its own window and ends it, is refused, signs
 * in again, and the person ends that one in Access. Every step is a receipt,
 * and none of it is a request that waits.
 */

import {
  PATIENCE,
  accessCollection,
  bell,
  notified,
  openInboxRecord,
  press,
  receipts,
} from "./device-inbox-tabs.mjs";
import { accessWorkspace } from "./local-access-journey.mjs";
import { expect } from "./patient-expect.mjs";

const SIGNED_IN = "Application signed in · Test application";
const ENDED = "Application sign-in ended · Test application";
const REFUSED = "Application sign-in refused · Test application";

/** The sign-in window's passkey counter has moved; hand the next one its credentials. */
const credentialsOf = async (device) =>
  (
    await device.cdp.send("WebAuthn.getCredentials", {
      authenticatorId: device.authenticatorId,
    })
  ).credentials;

/** The person ends the application's grant in Access › Grants, with the keyboard. */
async function endGrantAsPerson(main) {
  await accessCollection(main, "grants", "local-grants");
  const records = accessWorkspace(main);
  await openInboxRecord(
    main,
    records.getByRole("treeitem", {
      name: /^Local test person → Test application/,
    }),
  );
  await press(
    main,
    records.getByRole("button", { name: "Revoke grant", exact: true }),
  );
  await press(
    main,
    records.getByRole("button", { name: "Confirm revocation" }),
  );
  await expect(
    records.getByText("Application grant revoked.", { exact: true }),
  ).toHaveText("Application grant revoked.", { timeout: PATIENCE });
  await expect(records.getByRole("treeitem")).toHaveCount(0);
  await expect(records).toHaveAttribute("data-pane", "list");
  await expect(records.locator(".vault__list")).toBeVisible();
}

/** E. An application signs in, ends it, is refused, signs in again, and the person ends that. */
export async function applicationSignIn(t) {
  const { main, background, rp, context, mainDevice, rig, width } = t;
  const list = accessWorkspace(main).getByRole("tree", {
    name: "Receipts items",
  });
  // The passkey has been used in the front tab: its signature counter has moved
  // on, and a popup that began from the seeded credential would be a replay.
  const first = await rig.openConsent(
    rp,
    context,
    await credentialsOf(mainDevice),
    width,
  );
  await rig.approveConsent(rp, first.popup, width);
  await expect(rp.locator("output")).toHaveText(/^Signed in locally: local_/, {
    timeout: PATIENCE,
  });
  await expect(list).toContainText(SIGNED_IN, { timeout: PATIENCE });
  const fresh = await credentialsOf(first.device);
  await press(rp, rp.getByRole("button", { name: "Revoke", exact: true }));
  await expect(rp.locator("output")).toHaveText("Revoked", {
    timeout: PATIENCE,
  });
  await expect(list).toContainText(ENDED, { timeout: PATIENCE });
  const second = await rig.openConsent(rp, context, fresh, width);
  const closed = second.popup.waitForEvent("close");
  await press(
    second.popup,
    second.popup.getByRole("button", { name: "Deny", exact: true }),
  ).catch((error) => {
    if (!second.popup.isClosed()) throw error;
  });
  await closed;
  await expect(list).toContainText(REFUSED, { timeout: PATIENCE });
  // Signed in again; this time it is the person who ends it, in Access.
  const third = await rig.openConsent(rp, context, fresh, width);
  await rig.approveConsent(rp, third.popup, width);
  await expect(rp.locator("output")).toHaveText(/^Signed in locally: local_/, {
    timeout: PATIENCE,
  });
  await endGrantAsPerson(main);
  await press(rp, rp.getByRole("button", { name: "Check session" }));
  await expect(rp.locator("output")).toHaveText("Session refused", {
    timeout: PATIENCE,
  });
  await receipts(main, width);
  await expect(
    list.getByRole("treeitem").filter({ hasText: ENDED }),
  ).toHaveCount(2, {
    timeout: PATIENCE,
  });
  await expect(
    list.getByRole("treeitem").filter({ hasText: SIGNED_IN }),
  ).toHaveCount(2);
  // None of that was a request that waited, so none of it rang a doorbell: the
  // two rings are the two requests raised, and the title carries no mark.
  expect(
    await notified(background),
    "sign-in windows ring no doorbell",
  ).toHaveLength(2);
  expect(await background.title()).not.toMatch(/^\(\d+\)/);
  await expect(bell(background, t.width)).toHaveCount(0);
}
