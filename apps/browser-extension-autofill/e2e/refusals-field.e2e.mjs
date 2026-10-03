// What must not be filled because of the field itself, in a real browser: each
// test is an attack or a mistake the guard exists to stop, and each asserts
// the outcome the person is told, that the field is still empty, and that the
// page never came to hold the value.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fieldValue, frameOf, openLogin, pageSees } from "./harness/pages.mjs";
import {
  WORDS,
  mark,
  openPopup,
  pressFill,
  sendFill,
} from "./harness/popup.mjs";
import {
  assertUntouched,
  sendFillThrough,
  served,
  startReady,
  waitForRequest,
} from "./harness/ready.mjs";

let session;
before(async () => {
  session = await startReady();
});
after(async () => {
  await session?.close();
});

describe("a field a person could not see or aim at (DOM-based extension clickjacking)", () => {
  const cases = [
    ["opacity:0 on the field itself", "/opacity-zero", "transparent"],
    ["opacity:0 on an ancestor", "/opacity-ancestor", "transparent"],
    ["a transparent overlay above the field", "/covered", "covered"],
    ["a field placed off the screen", "/offscreen", "off_screen"],
  ];
  for (const [name, path, outcome] of cases) {
    it(`refuses ${name}, before the daemon is asked`, async () => {
      const since = served(session);
      const page = await openLogin(session, path, { focus: "#pass" });
      const popup = await openPopup(session, page);
      assert.equal(await mark(popup), WORDS.ready, "the popup cannot tell");
      assert.deepEqual(await pressFill(popup), { outcome });
      assert.equal(await mark(popup), WORDS.hidden);
      await assertUntouched(session, page, "#pass", since);
      await popup.close();
      await page.close();
    });
  }
});

describe("a page that changes while the value is on its way", () => {
  /** Press fill with the daemon holding its answer, and run `change` meanwhile. */
  async function pressWhileHeld(change, path = "/plain") {
    const since = served(session);
    session.daemon.state.fillDelayMs = 900;
    const page = await openLogin(session, path, { focus: "#pass" });
    const popup = await openPopup(session, page);
    try {
      const answer = pressFill(popup);
      // The guard has passed its first look and the daemon holds the answer.
      await waitForRequest(session, since);
      await change(page);
      return { answer: await answer, page, popup };
    } finally {
      session.daemon.state.fillDelayMs = 0;
    }
  }

  it("refuses when an overlay is drawn over the field", async () => {
    const { answer, page, popup } = await pressWhileHeld((page) =>
      page.evaluate(() => {
        const veil = document.createElement("div");
        veil.style.cssText =
          "position:fixed;inset:0;z-index:9;background:transparent";
        document.body.append(veil);
      }),
    );
    assert.deepEqual(answer, { outcome: "covered" });
    assert.equal(await fieldValue(page, "#pass"), "", "checked before writing");
    assert.deepEqual(await pageSees(page, session.secret), []);
    await popup.close();
    await page.close();
  });

  it("refuses when focus moves to another field of the same kind", async () => {
    // The field's kind does not change, so only the field's identity can tell.
    const { answer, page, popup } = await pressWhileHeld(
      (page) => page.locator("#pass2").focus(),
      "/two-passwords",
    );
    assert.deepEqual(answer, { outcome: "focus_moved" });
    assert.equal(await fieldValue(page, "#pass"), "");
    assert.equal(await fieldValue(page, "#pass2"), "");
    await popup.close();
    await page.close();
  });

  it("refuses when focus moves to another field", async () => {
    const { answer, page, popup } = await pressWhileHeld((page) =>
      page.locator("#user").focus(),
    );
    assert.deepEqual(answer, { outcome: "focus_moved" });
    assert.equal(await fieldValue(page, "#pass"), "");
    assert.equal(await fieldValue(page, "#user"), "");
    await popup.close();
    await page.close();
  });
});

describe("a field that is not the page's own", () => {
  for (const [name, path] of [
    ["a frame from another origin", "/frame"],
    ["a frame from the same origin", "/frame-same-origin"],
  ]) {
    it(`refuses ${name}`, async () => {
      const since = served(session);
      const page = await openLogin(session, path);
      const frame = await frameOf(page, "inner");
      await frame.locator("#pass").focus();
      const popup = await openPopup(session, page);
      assert.deepEqual(await pressFill(popup), { outcome: "no_focused_field" });
      assert.equal(await frame.locator("#pass").inputValue(), "");
      assert.equal(served(session), since);
      assert.deepEqual(await pageSees(page, session.secret), []);
      await popup.close();
      await page.close();
    });
  }

  it("refuses a field that is not a current password or a username", async () => {
    const since = served(session);
    const page = await openLogin(session, "/new-password", { focus: "#pass" });
    assert.deepEqual(await sendFillThrough(session, page), {
      outcome: "not_a_login_field",
    });
    await assertUntouched(session, page, "#pass", since);
    await page.close();
  });
});

describe("passkeys first", () => {
  for (const focus of ["#pass", "#user"]) {
    it(`reports a passkey and fills nothing, focus on ${focus}`, async () => {
      const since = served(session);
      const page = await openLogin(session, "/passkey", { focus });
      const popup = await openPopup(session, page);
      assert.equal(await mark(popup), WORDS.passkey, "the popup says so");
      const offered = await popup.evaluate(
        () => !document.getElementById("go").disabled,
      );
      assert.equal(offered, false, "the fill key is not offered");
      // Whatever the popup drew, the background and the guard refuse alone.
      assert.deepEqual(await sendFill(popup), { outcome: "passkey_offered" });
      await assertUntouched(session, page, focus, since);
      await popup.close();
      await page.close();
    });
  }
});

describe("passkeys first inside shadow roots", () => {
  const offered = [
    ["a sibling in the same open shadow root", "/shadow-passkey"],
    ["the same form inside a shadow root", "/shadow-form-passkey"],
    ["a sibling in a nested shadow root", "/shadow-nested-passkey"],
  ];
  for (const [name, path] of offered) {
    for (const focus of ["#pass", "#user"]) {
      it(`reports a passkey for ${name} and fills nothing, focus on ${focus}`, async () => {
        const since = served(session);
        const page = await openLogin(session, path, { focus });
        const popup = await openPopup(session, page);
        assert.equal(await mark(popup), WORDS.passkey, "the popup says so");
        assert.deepEqual(await sendFill(popup), { outcome: "passkey_offered" });
        await assertUntouched(session, page, focus, since);
        await popup.close();
        await page.close();
      });
    }
  }

  for (const [name, path] of [
    ["no passkey anywhere", "/shadow-plain"],
    ["a passkey field only in another root", "/shadow-other-root-passkey"],
  ]) {
    it(`still fills a shadow-root password with ${name}`, async () => {
      const page = await openLogin(session, path, { focus: "#pass" });
      const popup = await openPopup(session, page);
      assert.deepEqual(await pressFill(popup), { outcome: "filled" });
      assert.equal(await fieldValue(page, "#pass"), session.secret);
      await popup.close();
      await page.close();
    });
  }
});
