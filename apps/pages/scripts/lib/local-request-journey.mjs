import { expect } from "@playwright/test";
import { openLocalAccessPage } from "./local-access-journey.mjs";

export async function assertConsumedApplicationRequest(context, width) {
  const page = await openLocalAccessPage(context, width, "requests");
  const panel = page.getByRole("region", {
    name: "Local requests",
    exact: true,
  });
  const request = panel
    .getByRole("listitem")
    .filter({ hasText: "Application sign-in" });
  await expect(request).toContainText("consumed");
  await request.getByRole("button", { name: "Review request" }).click();
  await expect(
    panel.getByRole("button", { name: "Approve with passkey" }),
  ).toHaveCount(0);
  await page.close();
}

export async function localRequestJourney({
  width,
  seedJourney,
  authenticator,
  captures,
}) {
  const { context, credentials } = await seedJourney(false);
  const page = await openLocalAccessPage(context, width, "requests");
  await authenticator(page, credentials);
  const panel = page.getByRole("region", {
    name: "Local requests",
    exact: true,
  });
  const create = panel.getByRole("button", {
    name: "New local request",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByLabel("Requesting identity")).toBeFocused();
  await panel
    .getByRole("button", { name: "Sign in locally", exact: true })
    .click();
  await expect(panel.getByLabel("Local session status")).toHaveText(
    /Signed in locally with a passkey/,
  );
  await panel
    .getByLabel("Reason", { exact: true })
    .fill("Browser request approval proof");
  await capture(page, width, captures, "form");
  await panel
    .getByRole("button", { name: "Create local request", exact: true })
    .click();
  await expect(
    panel.getByText("Local request created. No access was granted."),
  ).toBeVisible();
  await expect(create).toBeFocused();
  await panel
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(panel.getByLabel("Approving person")).toBeFocused();
  await capture(page, width, captures, "review");
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(
    panel.getByText(
      "Request approved; awaiting single-use consumption by its requester.",
    ),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Reload local requests" }).click();
  await panel
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Approve with passkey" }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Withdraw request", exact: true })
    .click();
  await panel.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(panel.getByText("Request withdrawn.")).toBeVisible();
  await panel
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await panel.getByRole("button", { name: "Remove request history" }).click();
  await panel.getByRole("button", { name: "Confirm history removal" }).click();
  await expect(panel.getByText("Requests: -", { exact: true })).toBeVisible();
  await denyRequest(panel, create);
  await expireOpenRequest(page, panel, create);
  await capture(page, width, captures, "expired");
  await expect(
    page.getByText(/Connect Identity to.*approval requests/),
  ).toHaveCount(0);
  await context.close();
  console.log(
    `PASS ${width}px local requests: native keyboard creation, real bound passkey approval and denial, persisted decisions, withdrawal and history removal without a backend`,
  );
}

async function denyRequest(panel, create) {
  await create.click();
  await panel.getByLabel("Reason", { exact: true }).fill("Deny this request");
  await panel
    .getByRole("button", { name: "Create local request", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await panel.getByRole("button", { name: "Deny with passkey" }).click();
  await expect(
    panel.getByText("Request denied.", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Approve with passkey" }),
  ).toHaveCount(0);
}

async function expireOpenRequest(page, panel, create) {
  await panel.getByRole("button", { name: "Close request" }).click();
  await create.click();
  await panel
    .getByLabel("Reason", { exact: true })
    .fill("Expiry while reviewing");
  await panel
    .getByRole("button", { name: "Create local request", exact: true })
    .click();
  await panel
    .getByRole("listitem")
    .filter({ hasText: "Expiry while reviewing" })
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await page.context().clock.setFixedTime(new Date("2026-09-10T00:06:00Z"));
  await panel.getByRole("button", { name: "Reload local requests" }).click();
  await expect(
    panel.getByRole("group", { name: "Review local request" }),
  ).toContainText("expired");
  await expect(
    panel.getByRole("button", { name: "Approve with passkey" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Deny with passkey" }),
  ).toHaveCount(0);
}

async function capture(page, width, captures, state) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `${captures}/local-request-${state}-${width}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: state === "form" ? "Create local request" : "Close request",
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${captures}/local-request-${state}-controls-${width}.png`,
    fullPage: true,
  });
}
