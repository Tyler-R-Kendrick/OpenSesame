// The shipped manifest, unmodified, in a real browser: what the extension can
// reach before a person has granted it anything. (The other suites load the
// same build with the grants a person's "Allow" would give; see
// harness/session.mjs.)
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { guards } from "./harness/extension.mjs";
import { fieldValue, openLogin } from "./harness/pages.mjs";
import { WORDS, isShown, mark, openPopup, sendFill } from "./harness/popup.mjs";
import { startSession } from "./harness/session.mjs";

let session;
let worker;
before(async () => {
  session = await startSession({ standing: false });
  worker = await session.worker();
});
after(async () => {
  await session?.close();
});

/** Try to script the tab in view; the tab's address and the browser's answer. */
const tryToScriptActiveTab = () =>
  worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const seen = { url: tab.url ?? null };
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["fill-guard.js"],
      });
      return { ...seen, injected: true, why: "" };
    } catch (cause) {
      return { ...seen, injected: false, why: String(cause.message) };
    }
  });

/** Try the daemon's pairing route from the extension; whether the call got through. */
const tryToReachDaemon = () =>
  worker.evaluate(async () => {
    try {
      // Negative test: the browser must block the loopback daemon without a host grant.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      await fetch("http://127.0.0.1:18790/v1/fill/pair", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      return true;
    } catch {
      return false;
    }
  });

describe("no standing access", () => {
  it("declares no content script and holds no host permission", async () => {
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.host_permissions, undefined);
    assert.deepEqual([...manifest.permissions].sort(), [
      "activeTab",
      "scripting",
      "storage",
    ]);
    assert.ok(
      manifest.optional_host_permissions.includes("http://127.0.0.1/*"),
    );
    const held = await worker.evaluate(() => chrome.permissions.getAll());
    assert.deepEqual(held.origins, [], "the browser holds no host for it");
  });

  it("cannot read or script a page it was never granted", async () => {
    const page = await openLogin(session, "/plain", { focus: "#pass" });
    const outcome = await tryToScriptActiveTab();
    assert.equal(outcome.url, null, "the tab's address is not readable");
    assert.equal(outcome.injected, false);
    assert.match(
      outcome.why,
      /Cannot access contents of the page|host permission/i,
    );
    assert.deepEqual(await guards(session), []);
    await page.close();
  });

  it("cannot reach the daemon until the person grants its loopback host", async () => {
    assert.equal(await tryToReachDaemon(), false, "the browser stops the call");
    const answered = session.daemon.log.filter((row) => row.status < 300);
    assert.deepEqual(answered, []);
  });

  it("offers no key on a page it cannot see, and refuses a fill sent anyway", async () => {
    const page = await openLogin(session, "/plain", { focus: "#pass" });
    const popup = await openPopup(session, page);
    assert.equal(await mark(popup), WORDS.noPage);
    assert.equal(await isShown(popup, "site"), false);
    assert.equal(await isShown(popup, "go"), false);
    assert.deepEqual(await sendFill(popup, "Dev/app"), { outcome: "no_page" });
    assert.equal(await fieldValue(page, "#pass"), "");
    assert.equal(session.daemon.fills().length, 0);
    await popup.close();
    await page.close();
  });
});
