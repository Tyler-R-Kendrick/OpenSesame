/** Independent actor approvals through the real static popup callback. */
import {
  beginLinearConsent,
  finishLinearConsent,
  showSavedLinear,
} from "./linear-browser-consent.mjs";
import { LINEAR_TEST_CLIENT } from "./linear-provider-contract.mjs";
async function actorConsents(harness, page, label, authority, visit) {
  const { check } = harness;
  harness.setStep(`${label}-oauth-authorization`);
  await page
    .getByLabel("Connector Name", { exact: true })
    .fill(`${label}-oauth-contract`);
  check(
    (await page
      .getByLabel("Linear OAuth client ID", { exact: true })
      .inputValue()) === LINEAR_TEST_CLIENT,
    `${label}: managed mode reads the deployment OAuth client ID`,
  );
  check(
    (await page
      .getByLabel("Linear OAuth client ID", { exact: true })
      .getAttribute("readonly")) !== null,
    `${label}: managed application client ID is not editable`,
  );
  const denied = await beginLinearConsent(
    harness,
    page,
    label,
    "Create and authorize Linear",
  );
  check(
    new URL(denied.url()).searchParams.get("actor") === "app",
    `${label}: app consent begins first`,
  );
  const deniedState = new URL(denied.url()).searchParams.get("state");
  await finishLinearConsent(harness, page, denied, label, (popup) =>
    authority.deny(popup),
  );
  await page
    .getByRole("img", {
      name: "Linear authorization was declined; your connector is not authorized",
      exact: true,
    })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Save and authorize Linear", exact: true })
    .waitFor();
  check(
    (await page
      .getByRole("img", { name: "Linear connected", exact: true })
      .count()) === 0,
    `${label}: declined OAuth consent never activates the connector`,
  );
  const application = await beginLinearConsent(
    harness,
    page,
    label,
    "Save and authorize Linear",
  );
  const appState = new URL(application.url()).searchParams.get("state");
  check(
    appState !== deniedState,
    `${label}: retry after decline creates a fresh authorization transaction`,
  );
  await finishLinearConsent(harness, page, application, label, (popup) =>
    authority.consent(popup, "browser-app-code"),
  );
  await showSavedLinear(harness, page, visit, `${label}-oauth-contract`);
  await page
    .getByRole("region", { name: "App authorization", exact: true })
    .getByText("Protocol test account", { exact: true })
    .waitFor();
  check(
    page.context().pages().length === 1 &&
      (await page
        .getByRole("img", { name: "Linear connected", exact: true })
        .count()) === 0,
    `${label}: app approval waits for an explicit user-consent click without activating both actors`,
  );
  const user = await beginLinearConsent(harness, page, label, "Authorize user");
  check(
    new URL(user.url()).searchParams.get("actor") === "user" &&
      new URL(user.url()).searchParams.get("state") !== appState,
    `${label}: user scopes require independent user consent and fresh actor-bound state`,
  );
  await finishLinearConsent(harness, page, user, label, (popup) =>
    authority.consent(popup, "browser-user-code"),
  );
}
async function verifyActors(harness, page, label, authority) {
  const { check } = harness;
  await page
    .getByRole("img", { name: "Linear connected", exact: true })
    .waitFor();
  check(
    !/[?&](linear_code|linear_state|code|state)=/.test(page.url()),
    `${label}: authorization codes and state are removed from the address bar`,
  );
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  check(
    layout.content <= layout.width,
    `${label}: distinct granted actors and scopes do not overflow horizontally`,
  );
  await page.getByLabel("Act as", { exact: true }).selectOption("user");
  await page
    .getByRole("button", { name: "Read Linear issues", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Linear issues", exact: true })
    .waitFor();
  check(
    authority.calls.at(-1)?.authorization === "Bearer contract-oauth-user",
    `${label}: operations use the explicitly selected user grant`,
  );
  await page.getByLabel("Act as", { exact: true }).selectOption("app");
  await page
    .getByRole("button", { name: "Read Linear projects", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Linear projects", exact: true })
    .waitFor();
  check(
    authority.calls.at(-1)?.authorization === "Bearer contract-oauth-app",
    `${label}: application operations use the distinct application grant`,
  );
}

export async function oauthFlow(harness, page, label, authority, visit) {
  await actorConsents(harness, page, label, authority, visit);
  await verifyActors(harness, page, label, authority);
}
