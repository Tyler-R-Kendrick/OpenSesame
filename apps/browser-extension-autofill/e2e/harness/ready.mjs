// A session in which a person has already done the two one-time things: paired
// the extension with the daemon, and switched the test site on. Suites that
// attack the fill start from here.
import assert from "node:assert/strict";
import { fieldValue, openLogin, pageSees } from "./pages.mjs";
import { openPopup, sendFill, switchOnAndPair } from "./popup.mjs";
import { startSession } from "./session.mjs";

export async function startReady(options) {
  const session = await startSession(options);
  const page = await openLogin(session, "/plain", { focus: "#pass" });
  const popup = await openPopup(session, page);
  await switchOnAndPair(session, popup);
  await popup.close();
  await page.close();
  return session;
}

/** How many fills the daemon has answered with a value (status 200) so far. */
export const served = (session) =>
  session.daemon.fills().filter((row) => row.status === 200).length;

/**
 * A refusal leaves three things true: the field is empty, the daemon handed
 * out no value since `since` (a `served` count), and the page never came to
 * hold the value or throw.
 */
export async function assertUntouched(session, page, selector, since) {
  assert.equal(await fieldValue(page, selector), "", "the field stays empty");
  assert.equal(served(session), since, "the daemon served no value");
  assert.deepEqual(await pageSees(page, session.secret), []);
  assert.deepEqual(page.errors, []);
}

/** Send the fill message through a fresh popup, for a page the key would not be offered on. */
export async function sendFillThrough(session, page, reference) {
  const popup = await openPopup(session, page);
  try {
    return await sendFill(popup, reference);
  } finally {
    await popup.close();
  }
}

/** Wait until the daemon is holding a value request (or has served one past `since`). */
export async function waitForRequest(session, since) {
  for (let tries = 0; tries < 100; tries++) {
    if (session.daemon.pendingFills() > 0 || served(session) > since) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the daemon was never asked for a value");
}
