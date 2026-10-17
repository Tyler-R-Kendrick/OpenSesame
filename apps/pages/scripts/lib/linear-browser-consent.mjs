/** Real popup consent: the originating sealed vault never navigates or unlocks. */
import { expect } from "@playwright/test";

const CONSENT_POPUP_TIMEOUT_MS = 60_000;

export async function beginLinearConsent(harness, page, label, action) {
  const original = page.url();
  const button = page.getByRole("button", { name: action, exact: true });
  // Bind the popup to this click — context-wide "page" events can catch a stray tab.
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: CONSENT_POPUP_TIMEOUT_MS }),
    button.click(),
  ]);
  if (popup.isClosed()) {
    throw new Error(
      `${label}: consent popup closed before Linear authorize URL`,
    );
  }
  await popup
    .waitForURL("https://linear.app/oauth/authorize?**", {
      timeout: CONSENT_POPUP_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    })
    .catch(async (error) => {
      throw new Error(
        `${label}: consent window closed before Linear authorize URL: ${await page.getByRole("img").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")).join("; "))} :: ${await page
          .locator("body")
          .innerText()
          .then((text) => text.slice(0, 1200))}`,
        { cause: error },
      );
    });
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
  return popup;
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
