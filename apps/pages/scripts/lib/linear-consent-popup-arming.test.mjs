import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONSENT_POPUP_TIMEOUT_MS,
  openLinearConsentPopup,
} from "./linear-consent-popup-arming.mjs";

describe("openLinearConsentPopup", () => {
  it("is a function", () => {
    assert.equal(openLinearConsentPopup.name, "openLinearConsentPopup");
  });

  it("schedules waitForURL before the consent click resolves", async () => {
    let clickResolve;
    let navigationResolve;
    let clickResolved = false;
    const calls = [];
    const popup = {
      waitForURL(url, options) {
        calls.push(["waitForURL", url, options, clickResolved]);
        return new Promise((resolve) => {
          navigationResolve = resolve;
        });
      },
    };
    const page = {
      waitForEvent(event, options) {
        calls.push(["waitForEvent", event, options]);
        return Promise.resolve(popup);
      },
    };
    const button = {
      click() {
        calls.push("click");
        return new Promise((resolve) => {
          clickResolve = () => {
            clickResolved = true;
            calls.push("clickResolve");
            resolve();
          };
        });
      },
    };

    const pending = openLinearConsentPopup(page, button);
    await Promise.resolve();

    assert.equal(clickResolved, false);
    assert.ok(clickResolve);
    const armed = calls.find((call) => call[0] === "waitForURL");
    assert.ok(armed, "waitForURL must be scheduled while click is pending");
    assert.equal(armed[3], false);
    assert.equal(armed[1], "https://linear.app/oauth/authorize?**");
    assert.deepEqual(armed[2], {
      timeout: CONSENT_POPUP_TIMEOUT_MS,
      waitUntil: "commit",
    });
    assert.equal(CONSENT_POPUP_TIMEOUT_MS, 60_000);
    assert.deepEqual(
      calls.find((call) => call[0] === "waitForEvent"),
      ["waitForEvent", "popup", { timeout: CONSENT_POPUP_TIMEOUT_MS }],
    );

    navigationResolve();
    clickResolve();
    assert.equal(await pending, popup);
    assert.ok(
      calls.findIndex((call) => call[0] === "waitForURL") <
        calls.indexOf("clickResolve"),
    );
  });

  it("reports a superseded close that rejects before the click resolves", async () => {
    let clickResolve;
    let navigationReject;
    let clickResolved = false;
    let observedWhilePending = false;
    const popup = {
      isClosed: () => true,
      waitForURL() {
        return new Promise((_resolve, reject) => {
          navigationReject = reject;
        });
      },
    };
    const page = {
      waitForEvent() {
        return Promise.resolve(popup);
      },
    };
    const button = {
      click() {
        return new Promise((resolve) => {
          clickResolve = () => {
            clickResolved = true;
            resolve();
          };
        });
      },
    };

    const pending = openLinearConsentPopup(page, button, (opened) => {
      observedWhilePending = opened === popup && !clickResolved;
    });
    await Promise.resolve();
    assert.equal(clickResolved, false);
    assert.equal(observedWhilePending, true);
    assert.ok(navigationReject);
    assert.ok(clickResolve);

    navigationReject(new Error("page closed"));
    clickResolve();
    await assert.rejects(pending, /page closed/);
  });
});
