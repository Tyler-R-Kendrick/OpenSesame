import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, it } from "node:test";
import { connectBrowser } from "./harness/cdp.mjs";
import { askDaemonFor } from "./harness/extension.mjs";
import { fieldValue, openLogin } from "./harness/pages.mjs";
import {
  WORDS,
  everythingShown,
  isShown,
  mark,
  openPopup,
  pressFill,
  switchOnAndPair,
  waitMark,
} from "./harness/popup.mjs";
import { startSession } from "./harness/session.mjs";

let session;

// Optional, unapproved CI review material: capture only the actual popup,
// never the page containing the filled credential or the browser profile.
async function capturePopup(popup, name) {
  const directory = process.env.AUTOFILL_E2E_EVIDENCE_DIR;
  if (!directory) return;
  assert.equal((await everythingShown(popup)).includes(session.secret), false);
  const browser = await connectBrowser(session.profile);
  try {
    const { sessionId } = await browser.send("Target.attachToTarget", {
      targetId: popup.targetId,
      flatten: true,
    });
    const { data } = await browser.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sessionId,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  } finally {
    browser.close();
  }
}
before(async () => {
  session = await startSession({ requireApproval: true });
});
after(async () => {
  await session?.close();
});

it("requires independent site approval and one-use field approval even for a paired extension", async () => {
  const page = await openLogin(session, "/plain", { focus: "#pass" });
  let popup = await openPopup(session, page);
  await switchOnAndPair(session, popup);
  assert.equal(await mark(popup), WORDS.approval);
  assert.equal(await isShown(popup, "go"), false);
  assert.equal(await fieldValue(page, "#pass"), "");
  await capturePopup(popup, "approval-pending");
  const [match] = session.daemon.requests();
  assert.deepEqual(
    {
      extension: match.extension,
      origin: match.origin,
      reference: match.reference,
    },
    {
      extension: `chrome-extension://${session.id}`,
      origin: session.sites.origin("app.test"),
      reference: undefined,
    },
  );
  // Only the test operator channel authorizes; the extension cannot do this.
  session.daemon.authorize(match.id);
  await popup.close();
  popup = await openPopup(session, page);
  await waitMark(popup, WORDS.ready);
  assert.deepEqual(await pressFill(popup), { outcome: "approval_required" });
  assert.equal(await fieldValue(page, "#pass"), "");
  const [fill] = session.daemon.requests();
  assert.equal(fill.origin, session.sites.origin("app.test"));
  assert.equal(fill.reference, "Dev/app");
  assert.equal(fill.field, "password");
  session.daemon.authorize(fill.id);
  assert.deepEqual(await pressFill(popup), { outcome: "filled" });
  assert.equal(await fieldValue(page, "#pass"), session.secret);
  await waitMark(popup, WORDS.filled);
  await capturePopup(popup, "filled");
  assert.deepEqual(await pressFill(popup), { outcome: "approval_required" });
  const other = await askDaemonFor(
    session,
    session.sites.origin("app.test.evil.test"),
  );
  assert.equal(other.status, 403);
  assert.equal(other.hasValue, false);
  await popup.close();
  await page.close();
});
