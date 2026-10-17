import { describe, expect, it } from "vitest";
import {
  CONSENT_POPUP_TIMEOUT_MS,
  openLinearConsentPopup,
} from "./linear-consent-popup-arming.mjs";

describe("openLinearConsentPopup", () => {
  it("is a function", () => {
    expect(openLinearConsentPopup.name).toBe("openLinearConsentPopup");
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

    expect(clickResolved).toBe(false);
    expect(clickResolve).toBeTruthy();
    const armed = calls.find((call) => call[0] === "waitForURL");
    expect(
      armed,
      "waitForURL must be scheduled while click is pending",
    ).toBeTruthy();
    expect(armed[3]).toBe(false);
    expect(armed[1]).toBe("https://linear.app/oauth/authorize?**");
    expect(armed[2]).toEqual({
      timeout: CONSENT_POPUP_TIMEOUT_MS,
      waitUntil: "commit",
    });
    expect(CONSENT_POPUP_TIMEOUT_MS).toBe(60_000);
    expect(calls.find((call) => call[0] === "waitForEvent")).toEqual([
      "waitForEvent",
      "popup",
      { timeout: CONSENT_POPUP_TIMEOUT_MS },
    ]);

    navigationResolve();
    clickResolve();
    expect(await pending).toBe(popup);
    expect(calls.findIndex((call) => call[0] === "waitForURL")).toBeLessThan(
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
    expect(clickResolved).toBe(false);
    expect(observedWhilePending).toBe(true);
    expect(navigationReject).toBeTruthy();
    expect(clickResolve).toBeTruthy();

    navigationReject(new Error("page closed"));
    clickResolve();
    await expect(pending).rejects.toThrow(/page closed/);
  });
});
