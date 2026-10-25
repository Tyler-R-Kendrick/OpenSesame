import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { askDaemonFor } from "./harness/extension.mjs";
import { fieldValue, openLogin } from "./harness/pages.mjs";
import {
  WORDS,
  isShown,
  mark,
  openPopup,
  pressFill,
  switchOnAndPair,
  waitMark,
} from "./harness/popup.mjs";
import { startSession } from "./harness/session.mjs";

let session;
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
