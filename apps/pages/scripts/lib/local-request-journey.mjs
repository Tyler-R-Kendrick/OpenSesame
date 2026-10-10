import { expect } from "@playwright/test";
import {
  accessWorkspace,
  openLocalAccessPage,
  returnToAccessList,
  runAccessCommand,
  tabToAccessControl,
} from "./local-access-journey.mjs";

export async function assertConsumedApplicationRequest(context, width) {
  const page = await openLocalAccessPage(context, width, "requests");
  const panel = accessWorkspace(page);
  const request = await openRequest(page, "Application sign-in", "consumed");
  await expect(request).toContainText("consumed");
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
  const panel = accessWorkspace(page);
  const create = panel
    .getByRole("button", {
      name: "New local request",
      exact: true,
    })
    .filter({ visible: true });
  await createKeyboardRequest(page, panel, create, width, captures);
  await approveAndWithdrawRequest(page, panel, width, captures);
  await denyRequest(page, panel, create);
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

async function createKeyboardRequest(page, panel, create, width, captures) {
  await expect(create).toBeEnabled();
  await create.focus();
  await page.keyboard.press("Enter");
  await tabToAccessControl(page, panel.getByLabel("Requesting identity"));
  await expect(panel.getByLabel("Requesting identity")).toBeFocused();
  await panel
    .getByRole("button", { name: "Sign in locally", exact: true })
    .click();
  await expect(panel.getByLabel("Local session status")).toHaveText(
    /Signed in locally with a passkey/,
    { timeout: 30_000 },
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
  ).toHaveText("Local request created. No access was granted.", {
    timeout: 30_000,
  });
  if (width > 900) await expect(create).toBeFocused();
  else
    await expect(
      panel.getByRole("tree", { name: "Local requests items" }),
    ).toBeFocused();
}

async function approveAndWithdrawRequest(page, panel, width, captures) {
  await openRequest(page, "Browser request approval proof");
  await tabToAccessControl(page, panel.getByLabel("Approving person"));
  await expect(panel.getByLabel("Approving person")).toBeFocused();
  await capture(page, width, captures, "review");
  await panel.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(
    panel.getByText(
      "Request approved; awaiting single-use consumption by its requester.",
    ),
  ).toHaveText(
    "Request approved; awaiting single-use consumption by its requester.",
  );
  await runAccessCommand(page, "Reload local requests");
  await openRequest(page, "Browser request approval proof", "approved");
  await expect(
    panel.getByRole("button", { name: "Approve with passkey" }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Withdraw request", exact: true })
    .click();
  await panel.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(panel.getByText("Request withdrawn.")).toHaveText(
    "Request withdrawn.",
  );
  await openRequest(page, "Browser request approval proof", "revoked");
  await panel.getByRole("button", { name: "Remove request history" }).click();
  await panel.getByRole("button", { name: "Confirm history removal" }).click();
  await expect(
    panel.getByText("Request history removed.", { exact: true }),
  ).toHaveText("Request history removed.");
  await expect(panel.getByRole("treeitem")).toHaveCount(0);
  await expect(panel.locator(".vault__status-meta")).toHaveText("0");
}

async function denyRequest(page, panel, create) {
  await create.click();
  await panel.getByLabel("Reason", { exact: true }).fill("Deny this request");
  await panel
    .getByRole("button", { name: "Create local request", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Create local request", exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
  await openRequest(page, "Deny this request");
  await panel.getByRole("button", { name: "Deny with passkey" }).click();
  await expect(panel.getByText("Request denied.", { exact: true })).toHaveText(
    "Request denied.",
  );
  await openRequest(page, "Deny this request", "denied");
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
  await expect(
    panel.getByRole("button", { name: "Create local request", exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
  const opened = await openRequest(page, "Expiry while reviewing");
  const reference = await requestFieldValue(opened, "Reference");
  await page.context().clock.setFixedTime(new Date("2026-09-10T00:06:00Z"));
  await runAccessCommand(page, "Reload local requests");
  const expired = await openRequest(page, "Expiry while reviewing", "expired");
  await expect(expired).toContainText(reference);
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

/** A vault list row opens its record; reasons and status are fields in the detail pane. */
export async function openRequest(page, reason, status) {
  const workspace = accessWorkspace(page);
  await returnToAccessList(page);
  const entries = workspace.getByRole("treeitem");
  await expect(entries.first()).toBeVisible({ timeout: 30_000 });
  const count = await entries.count();
  for (let index = 0; index < count; index++) {
    await returnToAccessList(page);
    const row = workspace.getByRole("treeitem").nth(index);
    const id = await row.getAttribute("data-record-id");
    if (!id) continue;
    const entry = workspace.locator(`.vault__list [data-record-id="${id}"]`);
    await workspace.getByRole("tree", { name: "Local requests items" }).focus();
    await page.keyboard.type(`${index + 1}gg`);
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(entry).toHaveClass(/is-cursor/);
    await page.keyboard.press("Enter");
    await expect(entry).toHaveAttribute("aria-selected", "true");
    const review = workspace.getByRole("group", {
      name: "Review local request",
    });
    await expect(review).toBeVisible();
    const matchesReason =
      (await requestFieldValue(review, "Reason")) === reason;
    const matchesStatus =
      !status || (await requestFieldValue(review, "Status")) === status;
    if (matchesReason && matchesStatus) return review;
  }
  throw new Error(
    `No local request for ${reason}${status ? ` (${status})` : ""}`,
  );
}

/** FieldRow renders a label followed by its value as a text node. */
async function requestFieldValue(review, label) {
  const text = await review
    .locator(".frow__label", { hasText: new RegExp(`^${label}$`) })
    .locator("..")
    .textContent();
  return text.slice(label.length).trim();
}
