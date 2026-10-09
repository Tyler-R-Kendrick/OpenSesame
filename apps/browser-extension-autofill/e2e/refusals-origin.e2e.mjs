// What must not be filled because of where the request comes from, in a real
// browser: an origin that only looks like the entry's, a page that tries to
// reach the extension or the daemon itself, and a daemon that says no.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { askDaemonFor } from "./harness/extension.mjs";
import { openLogin } from "./harness/pages.mjs";
import {
  WORDS,
  isShown,
  mark,
  openPopup,
  sendFill,
  waitMark,
} from "./harness/popup.mjs";
import { assertUntouched, served, startReady } from "./harness/ready.mjs";

let session;
before(async () => {
  session = await startReady();
});
after(async () => {
  await session?.close();
});

describe("an origin that only looks like the entry's", () => {
  const lookalikes = [
    "app.test.evil.test", // the entry's host as a prefix of another's
    "xapp.test", // the entry's host as a suffix of another's
    "sub.app.test", // a subdomain of the entry's host
  ];
  for (const host of lookalikes) {
    it(`offers nothing on ${host}, and the daemon refuses it by name`, async () => {
      const since = served(session);
      const page = await openLogin(session, "/plain", { host, focus: "#pass" });
      const popup = await openPopup(session, page);
      await popup.click("#site"); // a person may switch it on; the daemon decides
      await waitMark(popup, WORDS.noMatch);
      assert.equal(await isShown(popup, "go"), false, "no entry is offered");
      assert.deepEqual(await sendFill(popup, "Dev/app"), {
        outcome: "no_match",
      });
      await assertUntouched(session, page, "#pass", since);
      await popup.close();
      await page.close();
    });
  }

  it("answers a value only for the entry's exact origin, whoever asks", async () => {
    const app = session.sites.origin("app.test");
    const probes = [
      [app, 200],
      [`${app}/`, 400], // not the canonical serialization
      [session.sites.origin("app.test.evil.test"), 404],
      [session.sites.origin("xapp.test"), 404],
      [session.sites.origin("sub.app.test"), 404],
      [app.replace("http:", "https:"), 404], // another scheme
      [app.replace(/:\d+$/, ""), 404], // another port (the default one)
      [app.replace(/:\d+$/, ":1"), 404],
      ["file:///etc/passwd", 400],
    ];
    for (const [origin, status] of probes) {
      // From the extension itself, so the browser stamps the real Origin.
      const answered = await askDaemonFor(session, origin);
      assert.equal(answered.status, status, origin);
      assert.equal(answered.hasValue, status === 200, `${origin}: value?`);
    }
  });
});

describe("the page itself", () => {
  /** Everything a page can try against the extension and the daemon. */
  const tryEverything = (extensionId) => {
    const tried = {
      runtimeAbsent: globalThis.chrome?.runtime?.sendMessage === undefined,
    };
    const guess = {
      type: "opensesame.fill",
      op: "value",
      nonce: "guess",
      field: "password",
    };
    const body = { reference: "Dev/app", origin: location.origin };
    return Promise.resolve()
      .then(() => globalThis.chrome.runtime.sendMessage(extensionId, guess))
      .then(
        () => Object.assign(tried, { message: "sent" }),
        () => Object.assign(tried, { message: "refused" }),
      )
      .then(() =>
        // Negative test: an unpaired web page must not receive values from the loopback daemon.
        // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
        fetch("http://127.0.0.1:18790/v1/fill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, field: "password" }),
        }),
      )
      .then(
        (response) =>
          Object.assign(tried, { fetch: `status ${response.status}` }),
        () => Object.assign(tried, { fetch: "blocked" }),
      )
      .then(() => {
        // The page shouts at the guard in every way a page can.
        const arm = {
          type: "opensesame.fill.arm",
          mode: "fill",
          nonce: "n",
          origin: location.origin,
          trigger: "popup",
          armedAt: Date.now(),
        };
        window.postMessage(arm, "*");
        document.dispatchEvent(
          new CustomEvent("opensesame.fill.arm", { detail: arm }),
        );
        return tried;
      });
  };

  it("cannot ask the daemon for a value, and cannot message the extension", async () => {
    const since = served(session);
    const page = await openLogin(session, "/hostile", { focus: "#pass" });
    const tried = await page.evaluate(tryEverything, session.id);
    assert.equal(tried.runtimeAbsent, true, "a web page gets no messaging");
    assert.equal(
      tried.fetch,
      "blocked",
      "the daemon's answer never reaches a page",
    );
    await page.waitForTimeout(400);
    await assertUntouched(session, page, "#pass", since);
    const seen = await page.evaluate(() => window.__seen);
    assert.equal(seen.setterCalls, 0);
    await page.close();
  });
});

describe("the daemon says no", () => {
  it("reports an off plugin as one mark and fills nothing", async () => {
    const since = served(session);
    session.daemon.state.pluginActive = false;
    try {
      const page = await openLogin(session, "/plain", { focus: "#pass" });
      const popup = await openPopup(session, page);
      assert.equal(await mark(popup), WORDS.pluginOff);
      assert.equal(await isShown(popup, "go"), false);
      assert.deepEqual(await sendFill(popup), { outcome: "plugin_off" });
      await assertUntouched(session, page, "#pass", since);
      await popup.close();
      await page.close();
    } finally {
      session.daemon.state.pluginActive = true;
    }
  });
});
