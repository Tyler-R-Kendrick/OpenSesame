/** Real popup consent: the originating sealed vault never navigates or unlocks. */
import { expect } from "@playwright/test";
import { readLinearStatusCodes } from "./linear-consent-status.mjs";

const CONSENT_POPUP_TIMEOUT_MS = 60_000;

let consentAttempt = 0;

function consentLocation(target, original) {
  try {
    const url = new URL(target.url());
    const initial = new URL(original);
    if (url.href === "about:blank") return { location: "blank" };
    if (
      (url.origin === initial.origin && url.pathname === initial.pathname) ||
      (url.origin === "https://linear.app" &&
        url.pathname === "/oauth/authorize")
    )
      return { origin: url.origin, path: url.pathname };
    return { location: "other" };
  } catch {
    return { location: "unavailable" };
  }
}

/** Observe this click's exact popup, never a context-wide candidate or app hook. */
function observeConsent(harness, page, original) {
  const attempt = ++consentAttempt;
  const context = page.context();
  const browser = context.browser();
  const listeners = [];
  let popup;
  let contextClosed = false;
  let stopped = false;
  let sequence = 0;
  const note = (event, frame, status) => {
    if (stopped || sequence >= 32) return;
    try {
      if (frame && frame !== popup.mainFrame()) return;
      const location = popup
        ? consentLocation(popup, original)
        : { location: "unbound" };
      const detail = {
        attempt,
        sequence: ++sequence,
        event,
        openerClosed: page.isClosed(),
        contextClosed,
        browserConnected: browser?.isConnected() ?? false,
        popupClosed: popup?.isClosed() ?? null,
        ...location,
      };
      if (status) detail.status = status;
      harness.record("CONSENT-LIFECYCLE", JSON.stringify(detail));
    } catch {
      return;
    }
  };
  const listen = (target, event, callback) => {
    try {
      target.on(event, callback);
      listeners.push(() => {
        try {
          target.off(event, callback);
        } catch {
          return;
        }
      });
    } catch {
      return;
    }
  };
  listen(page, "close", () => note("opener-close"));
  listen(context, "close", () => {
    contextClosed = true;
    note("context-close");
  });
  if (browser)
    listen(browser, "disconnected", () => note("browser-disconnected"));
  note("click-start");
  return {
    bind(target) {
      if (stopped) return;
      popup = target;
      listen(popup, "close", () => note("popup-close"));
      listen(popup, "crash", () => note("popup-crash"));
      listen(popup, "framenavigated", (frame) =>
        note("popup-navigation", frame),
      );
      note("popup-bound");
    },
    note,
    async status(event) {
      try {
        const codes = await readLinearStatusCodes(page);
        const authorizeDisabled = await page
          .getByRole("button", { name: /^(Authorize|Reconnect) application$/ })
          .evaluateAll((buttons) =>
            buttons.map((button) => button.matches(":disabled")),
          );
        const cancelCount = await page
          .getByRole("button", { name: "Cancel sign-in", exact: true })
          .count();
        note(event, undefined, { codes, authorizeDisabled, cancelCount });
      } catch {
        note(event, undefined, { unavailable: true });
      }
    },
    stop() {
      stopped = true;
      for (const remove of listeners) remove();
    },
  };
}

export async function beginLinearConsent(harness, page, label, action) {
  const original = page.url();
  const button = page.getByRole("button", { name: action, exact: true });
  let popup;
  let observation;
  // A reserved consent window can be released when its preparation ends
  // against a superseded attempt; one fresh click starts the real consent.
  for (let attempt = 1; ; attempt += 1) {
    observation = observeConsent(harness, page, original);
    try {
      // Bind the popup to this click — context-wide "page" events can catch a stray tab.
      [popup] = await Promise.all([
        page.waitForEvent("popup", {
          timeout: CONSENT_POPUP_TIMEOUT_MS,
          predicate: (popup) => {
            observation.bind(popup);
            return true;
          },
        }),
        button.click(),
      ]);
      if (popup.isClosed()) {
        throw new Error(
          `${label}: consent popup closed before Linear authorize URL`,
        );
      }
      await popup.waitForURL("https://linear.app/oauth/authorize?**", {
        timeout: CONSENT_POPUP_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      break;
    } catch (error) {
      observation.note("consent-error");
      observation.stop();
      const ended =
        (await page
          .getByRole("button", { name: "Cancel sign-in", exact: true })
          .count()) === 0;
      if (attempt >= 2 || !ended || !popup?.isClosed())
        throw new Error(
          `${label}: consent window closed before Linear authorize URL: ${await page.getByRole("img").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")).join("; "))} :: ${await page
            .locator("body")
            .innerText()
            .then((text) => text.slice(-1200))}`,
          { cause: error },
        );
      await expect(button).toBeEnabled({ timeout: 10_000 });
    }
  }
  try {
    await popup
      .getByText("Test-only OAuth consent transport.", { exact: true })
      .waitFor();
    harness.check(
      page.url() === original,
      `${label}: provider consent preserves the originating tab URL`,
    );
    harness.check(
      (await page.getByLabel("PIN", { exact: true }).count()) === 0,
      `${label}: provider consent keeps the originating vault unlocked`,
    );
    harness.check(
      await popup.evaluate(() => window.opener === null),
      `${label}: Linear receives no originating-window capability`,
    );
    await expect(
      page.getByRole("button", { name: "Cancel sign-in", exact: true }),
    ).toBeEnabled();
    observation.note("consent-ready");
    return popup;
  } catch (error) {
    observation?.note("consent-error");
    await observation?.status("status-after-error");
    throw error;
  } finally {
    observation?.stop();
  }
}

export async function finishLinearConsent(
  harness,
  page,
  popup,
  label,
  respond,
) {
  const original = page.url();
  const closed = popup.waitForEvent("close", {
    timeout: CONSENT_POPUP_TIMEOUT_MS,
  });
  await respond(popup);
  await closed;
  await expect(
    page.getByRole("button", { name: "Cancel sign-in", exact: true }),
  ).toHaveCount(0);
  harness.check(
    !/[?&](linear_code|linear_state|code|state|error)=/.test(popup.url()),
    `${label}: callback bridge scrubs credentials before closing the provider window`,
  );
  harness.check(
    page.url() === original,
    `${label}: completed consent leaves the originating tab on its connector`,
  );
  harness.check(
    (await page.getByLabel("PIN", { exact: true }).count()) === 0,
    `${label}: completed consent does not ask the originating vault to unlock again`,
  );
}

/** Reload the public Connections list through its control, without relocking the vault. */
export async function showSavedLinear(harness, page, visit, name) {
  await visit(page, "connections");
  await page
    .getByRole("button", { name: "Reload connections", exact: true })
    .click();
  const rows = page.locator("#connected .conn-service").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
  await rows.first().waitFor();
  harness.check(
    (await rows.count()) === 1,
    `${name}: configuration and retry retain one durable connector`,
  );
  const rowId = await rows.first().getAttribute("id");
  if (!rowId?.startsWith("connected-"))
    throw new Error("Saved Linear row has no connection identity");
  const id = decodeURIComponent(rowId.slice("connected-".length));
  await visit(page, `connections/linear/${encodeURIComponent(id)}`);
  return id;
}
