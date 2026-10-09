/** Recover real sealed records through UI controls; faults affect provider HTTP only. */
import { PIN, unlockWithPin } from "./pages-journey.mjs";

const connected = (page) =>
  page.getByRole("img", { name: "Linear connected", exact: true });
const incomplete = (page) =>
  page.getByRole("img", {
    name: "Linear authorization incomplete",
    exact: true,
  });
const retry = (page) =>
  page.getByRole("button", { name: "Retry webhook setup", exact: true });

async function scopes(page, label, selected) {
  const summary = page.getByLabel(label, { exact: true });
  const details = page.locator("details").filter({ has: summary });
  if ((await details.getAttribute("open")) === null) await summary.click();
  for (const checkbox of await details.getByRole("checkbox").all()) {
    const name = (await checkbox.locator("..").innerText()).trim();
    await checkbox.setChecked(selected.includes(name));
  }
  await summary.click();
}

async function finishConsent(page, authority, code, nextConsent = false) {
  await authority.consent(page, code);
  if (nextConsent) {
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await page.waitForURL("https://linear.app/oauth/authorize?**");
  } else await unlockWithPin(page);
}

function revokeGrant(authority, code) {
  const grant = [...authority.remote.grants.values()].find(({ access }) =>
    access.endsWith(`-${code}`),
  );
  if (!grant) throw new Error(`Missing protocol grant ${code}`);
  authority.remote.revoked.add(grant.access);
  authority.remote.revoked.add(grant.refresh);
  return grant;
}

function wasRevoked(authority, token) {
  return authority.calls.some(
    ({ path, form }) => path === "/oauth/revoke" && form?.token === token,
  );
}

async function configureWebhook(page, enabled) {
  await page
    .getByLabel("Register a Linear webhook", { exact: true })
    .setChecked(enabled);
  if (enabled)
    await page
      .getByLabel("Webhook delivery URL", { exact: true })
      .fill("https://hooks.example.test/linear");
}

async function createRegistered({ harness }, page, label, authority) {
  harness.setStep(`${label}-registered-oauth-webhook`);
  authority.remote.uniqueGrants = true;
  await scopes(page, "App Scopes", ["read", "admin"]);
  await scopes(page, "User Scopes", []);
  await page
    .getByLabel("Expected Linear workspace (optional)", { exact: true })
    .fill("");
  await configureWebhook(page, true);
  await page
    .getByRole("button", { name: "Save and authorize Linear", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  await finishConsent(page, authority, "registered-initial");
  await connected(page).waitFor();
  harness.check(
    authority.remote.webhooks.size === 1,
    `${label}: OAuth app creates one real provider webhook`,
  );
  return [...authority.remote.webhooks.keys()][0];
}

async function expireRegistered({ harness }, page, label, authority, oldId) {
  harness.setStep(`${label}-expired-app-original-workspace`);
  const oldGrant = revokeGrant(authority, "registered-initial");
  await page.clock.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
  await page
    .getByRole("button", { name: "Read Linear issues", exact: true })
    .click();
  await incomplete(page).waitFor();
  harness.check(
    authority.calls.some(
      ({ path, form }) =>
        path === "/oauth/token" && form?.refresh_token === oldGrant.refresh,
    ),
    `${label}: expired OAuth refresh refusal requires reconnection`,
  );
  await page
    .getByRole("button", { name: "Reconnect application", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  harness.check(
    authority.remote.webhooks.has(oldId),
    `${label}: beginning recovery retains the original provider webhook`,
  );
  authority.remote.wrongWorkspaceCode = "registered-wrong";
  await finishConsent(page, authority, "registered-wrong");
  await page
    .getByRole("img", {
      name: "Reconnect the original Linear workspace to recover its webhook",
      exact: true,
    })
    .waitFor();
  harness.check(
    authority.remote.webhooks.has(oldId) &&
      (await connected(page).count()) === 0,
    `${label}: wrong-workspace recovery is rejected even with no configured workspace filter`,
  );
  harness.check(
    wasRevoked(authority, "contract-oauth-app-registered-wrong"),
    `${label}: wrong-workspace replacement grant is compensated`,
  );
}

async function retryRegistered(
  { harness, visit },
  page,
  label,
  authority,
  oldId,
) {
  harness.setStep(`${label}-webhook-cleanup-retry`);
  await page
    .getByRole("button", { name: "Authorize application", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  authority.remote.failDelete = true;
  await finishConsent(page, authority, "registered-replacement");
  await retry(page).waitFor();
  await incomplete(page).waitFor();
  harness.check(
    authority.remote.webhooks.has(oldId),
    `${label}: failed provider cleanup retains the previous webhook obligation`,
  );
  authority.expectedCallbacks.add(page.url());
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await visit(page, "connections/linear");
  await retry(page).waitFor();
  await incomplete(page).waitFor();
  await page
    .getByRole("region", { name: "Linear webhook", exact: true })
    .getByRole("img", {
      name: "Previous webhook cleanup pending in its original workspace",
      exact: true,
    })
    .waitFor();
  await retry(page).scrollIntoViewIfNeeded();
  const retryBox = await retry(page).boundingBox();
  harness.record(
    "RECOVERY-MEASUREMENT",
    `${label}: cleanup retry button ${Math.round(retryBox.width)} × ${Math.round(retryBox.height)}px`,
  );
  if (label === "phone")
    harness.check(
      retryBox.height >= 44,
      `${label}: cleanup retry retains a 44px touch target`,
    );
  await harness.snap(page, `${label}-cleanup-retry-protocol-test`, {
    fullPage: false,
  });
  authority.remote.failDelete = false;
  await retry(page).click();
  await connected(page).waitFor();
  harness.check(
    !authority.remote.webhooks.has(oldId) &&
      authority.remote.webhooks.size === 1,
    `${label}: explicit retry replaces the old webhook exactly once`,
  );
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await connected(page).waitFor({ state: "detached" });
}

async function createPending({ harness, visit }, page, label, authority) {
  harness.setStep(`${label}-lost-webhook-create-response`);
  await visit(page, "connections/linear");
  await page
    .getByLabel("Connector Name", { exact: true })
    .fill(`${label}-pending-hook`);
  await scopes(page, "App Scopes", ["read", "admin"]);
  await scopes(page, "User Scopes", []);
  await configureWebhook(page, true);
  authority.remote.loseCreate = true;
  authority.remote.failList = true;
  await page
    .getByRole("button", { name: "Create and authorize Linear", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  await finishConsent(page, authority, "pending-initial");
  await incomplete(page).waitFor();
  await retry(page).waitFor();
  harness.check(
    authority.remote.webhooks.size === 1,
    `${label}: lost create response preserves the remote webhook and sealed recovery intent`,
  );
  harness.check(
    (await page
      .getByRole("region", { name: "Linear webhook", exact: true })
      .count()) === 0,
    `${label}: unconfirmed webhook is never presented as registered`,
  );
  authority.expectedCallbacks.add(page.url());
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await visit(page, "connections/linear");
  await incomplete(page).waitFor();
  await retry(page).waitFor();
  harness.check(
    authority.remote.webhooks.size === 1,
    `${label}: pending recovery survives a cold sealed-vault reload`,
  );
  return [...authority.remote.webhooks.keys()][0];
}

async function narrowPending({ harness }, page, label, authority, oldId) {
  harness.setStep(`${label}-pending-hook-temporary-admin`);
  revokeGrant(authority, "pending-initial");
  authority.remote.failList = false;
  await scopes(page, "App Scopes", ["read"]);
  await configureWebhook(page, false);
  await page
    .getByRole("button", { name: "Save and authorize Linear", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  harness.check(
    new URL(page.url()).searchParams.get("scope") === "read,admin",
    `${label}: pending webhook cleanup explicitly requests temporary admin consent`,
  );
  await finishConsent(page, authority, "pending-cleanup", true);
  harness.check(
    !authority.remote.webhooks.has(oldId) &&
      authority.remote.webhooks.size === 0,
    `${label}: recovered pending webhook is deleted before disabling triggers`,
  );
  harness.check(
    wasRevoked(authority, "contract-oauth-app-pending-cleanup") &&
      wasRevoked(authority, "contract-refresh-app-pending-cleanup"),
    `${label}: temporary cleanup access and refresh tokens are revoked`,
  );
  harness.check(
    new URL(page.url()).searchParams.get("scope") === "read",
    `${label}: cleanup requires a separate final consent with only selected read scope`,
  );
  await finishConsent(page, authority, "pending-final");
  await connected(page).waitFor();
  await page
    .getByRole("region", { name: "App authorization", exact: true })
    .getByText("read", { exact: true })
    .waitFor();
  harness.check(
    (await retry(page).count()) === 0 && authority.remote.webhooks.size === 0,
    `${label}: final narrowed connector has no outstanding webhook cleanup`,
  );
  await page
    .getByRole("button", { name: "Read Linear issues", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Linear issues", exact: true })
    .waitFor();
  harness.check(
    authority.calls.at(-1)?.authorization ===
      "Bearer contract-oauth-app-pending-final",
    `${label}: final operations use the narrowed replacement grant`,
  );
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  harness.check(
    layout.content <= layout.viewport,
    `${label}: recovered connector controls do not overflow horizontally`,
  );
  await page
    .getByRole("region", { name: "App authorization", exact: true })
    .scrollIntoViewIfNeeded();
  await harness.snap(page, `${label}-narrowed-recovery-protocol-test`, {
    fullPage: false,
  });
}

export async function recoveryFlow(dependencies, page, label, authority) {
  const registered = await createRegistered(
    dependencies,
    page,
    label,
    authority,
  );
  await expireRegistered(dependencies, page, label, authority, registered);
  await retryRegistered(dependencies, page, label, authority, registered);
  const pending = await createPending(dependencies, page, label, authority);
  await narrowPending(dependencies, page, label, authority, pending);
}
