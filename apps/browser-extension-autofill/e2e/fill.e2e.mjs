// The happy path in a real browser: a person switches a site on, pairs, and
// fills the focused password field; and what the page, the console, the popup
// and storage are never told while it happens. The tests run in order and
// build on one another, as a person's first minutes with the extension do.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { guards, storedState, waitForGuards } from "./harness/extension.mjs";
import { fieldValue, openLogin, pageSees } from "./harness/pages.mjs";
import {
  WORDS,
  everythingShown,
  isShown,
  mark,
  openPopup,
  originShown,
  pressFill,
  sendFill,
  siteIsOn,
  switchOnAndPair,
  waitMark,
} from "./harness/popup.mjs";
import { startSession } from "./harness/session.mjs";

let session;
before(async () => {
  session = await startSession();
});
after(async () => {
  await session?.close();
});

/** Open the login page with `focus` focused, and the popup over it. */
async function login(path, focus) {
  const page = await openLogin(session, path, { focus });
  return { page, popup: await openPopup(session, page) };
}

describe("before a person has switched a site on", () => {
  it("does nothing on a page load, and no guard exists", async () => {
    const page = await openLogin(session, "/plain", { focus: "#pass" });
    await page.waitForTimeout(600);
    assert.equal(await fieldValue(page, "#pass"), "");
    assert.equal(session.daemon.log.length, 0, "the daemon was never asked");
    assert.deepEqual(await guards(session), []);
    await page.close();
  });
});

describe("switching on and pairing", () => {
  it("goes through the popup's own keys", async () => {
    const { page, popup } = await login("/plain", "#pass");
    assert.equal(await originShown(popup), session.sites.origin("app.test"));
    assert.equal(await siteIsOn(popup), false);
    assert.equal(await mark(popup), WORDS.siteOff);

    await switchOnAndPair(session, popup);

    assert.equal(await siteIsOn(popup), true);
    assert.equal(await isShown(popup, "go"), true);
    // The extension spoke to the daemon as itself, on loopback, with its
    // browser-stamped origin, and the daemon knows it now.
    const own = `chrome-extension://${session.id}`;
    const origins = new Set(session.daemon.log.map((row) => row.origin));
    assert.deepEqual([...origins].filter(Boolean), [own]);
    assert.ok(session.daemon.isPaired(own));
    await popup.close();
    await page.close();
  });
});

describe("filling", () => {
  it("fills the focused password field when the person presses the fill key", async () => {
    const { page, popup } = await login("/plain", "#pass");
    assert.equal(await mark(popup), WORDS.ready);
    assert.deepEqual(await pressFill(popup), { outcome: "filled" });
    await waitMark(popup, WORDS.filled);
    assert.equal(await fieldValue(page, "#pass"), session.secret);
    assert.equal(await fieldValue(page, "#user"), "", "only the focused field");
    await popup.close();
    await page.close();
  });

  it("fills the username field too, and asks the daemon for that field only", async () => {
    const { page, popup } = await login("/plain", "#user");
    assert.deepEqual(await pressFill(popup), { outcome: "filled" });
    assert.equal(await fieldValue(page, "#user"), session.login);
    assert.equal(await fieldValue(page, "#pass"), "");
    assert.equal(session.daemon.fills().at(-1).field, "username");
    await popup.close();
    await page.close();
  });

  it("uses the registered guard on a page loaded after the site was switched on", async () => {
    assert.equal((await guards(session)).length, 1, "one site, one guard");
    const { page, popup } = await login("/plain", "#pass");
    assert.deepEqual(await pressFill(popup), { outcome: "filled" });
    assert.equal(await fieldValue(page, "#pass"), session.secret);
    await popup.close();
    await page.close();
  });
});

describe("what nobody else sees", () => {
  it("keeps the value from a hostile page, the console, the popup and storage", async () => {
    const { page, popup } = await login("/hostile", "#pass");
    const requests = [];
    page.on("request", (request) => {
      requests.push(`${request.url()} ${request.postData() ?? ""}`);
    });
    assert.deepEqual(await pressFill(popup), { outcome: "filled" });
    assert.equal(await fieldValue(page, "#pass"), session.secret);

    // The page hooked the value setter on the prototype and on the field: the
    // guard writes through the browser's own setter in its isolated world.
    const seen = await page.evaluate(() => window.__seen);
    assert.equal(seen.setterCalls, 0, "prototype setter hook never ran");
    assert.equal(seen.instanceSetterCalls, 0, "field setter hook never ran");
    assert.deepEqual(seen.strings, []);
    assert.deepEqual(await pageSees(page, session.secret), []);
    const marker = await page.evaluate(
      () => Symbol.for("opensesame.fill.guard") in window,
    );
    assert.equal(marker, false, "the guard's mark is not on the page's window");
    assert.deepEqual(
      requests.filter((line) => line.includes(session.secret)),
      [],
    );
    assert.deepEqual(page.errors, []);

    const heard = session.consoles.filter((line) =>
      line.includes(session.secret),
    );
    assert.deepEqual(heard, []);
    assert.equal(
      (await everythingShown(popup)).includes(session.secret),
      false,
    );
    assert.equal(popup.console.join("\n").includes(session.secret), false);
    assert.equal((await storedState(session)).includes(session.secret), false);
    await popup.close();
    await page.close();
  });
});

describe("switching off", () => {
  it("unregisters the guard, and nothing fills after", async () => {
    const page = await openLogin(session, "/plain", { focus: "#pass" });
    const first = await openPopup(session, page);
    assert.equal(await siteIsOn(first), true);
    await first.click("#site");
    assert.deepEqual(await waitForGuards(session, 0), []);
    // (In this session the browser will not give back a grant the manifest
    // holds, so the first popup's mark reports that; a person's own grant
    // goes back. What the switch owes is asserted on the registrations and a
    // fresh popup.)
    await first.close();

    const popup = await openPopup(session, page);
    assert.equal(await siteIsOn(popup), false);
    assert.equal(await mark(popup), WORDS.siteOff);
    assert.equal(await isShown(popup, "go"), false);
    const before = session.daemon.fills().length;
    assert.deepEqual(await sendFill(popup), { outcome: "site_off" });
    assert.equal(session.daemon.fills().length, before, "no value requested");
    assert.equal(await fieldValue(page, "#pass"), "");
    await popup.close();
    await page.close();
  });
});
