import { isString } from "../../../../scripts/lib/json-boundary.mjs";
import {
  LINEAR_TEST_CLIENT,
  LINEAR_TEST_KEY,
} from "./linear-provider-contract.mjs";
/** Real controls exercise provider HTTP authorization and operations in a sealed PIN vault. */
import { PIN, unlockWithPin } from "./pages-journey.mjs";
async function connected(page) {
  await page
    .getByRole("img", { name: "Linear connected", exact: true })
    .waitFor();
}

async function verifyApiKey({ harness, verifyIcon }, page, label) {
  const { check } = harness;
  harness.setStep(`${label}-api-key-verification`);
  const iconSource = await verifyIcon(page, label);
  await page
    .getByLabel("Connector Name", { exact: true })
    .fill(`${label}-linear-contract`);
  await page
    .getByRole("radio", { name: "Bring Your Own", exact: true })
    .check();
  await page.getByRole("radio", { name: "API key", exact: true }).check();
  const key = page.getByLabel("Linear API key", { exact: true });
  const submit = page.getByRole("button", {
    name: "Verify and connect Linear",
    exact: true,
  });
  await key.fill("lin_api_invalid_contract");
  await submit.click();
  await page
    .getByRole("img", {
      name: "Linear authorization expired or was refused. Reconnect Linear.",
      exact: true,
    })
    .first()
    .waitFor();
  check(
    (await page
      .getByRole("img", { name: "Linear connected", exact: true })
      .count()) === 0,
    `${label}: invalid credentials never become connected`,
  );
  await key.fill(LINEAR_TEST_KEY);
  const workspace = page.getByLabel("Expected Linear workspace (optional)", {
    exact: true,
  });
  await workspace.fill("different-workspace");
  await submit.click();
  await page
    .getByRole("img", { name: /does not match/ })
    .first()
    .waitFor();
  check(
    (await page
      .getByRole("img", { name: "Linear connected", exact: true })
      .count()) === 0,
    `${label}: workspace mismatch never becomes connected`,
  );
  await workspace.fill("browser-contract");
  await page.getByLabel("Register a Linear webhook", { exact: true }).check();
  await page
    .getByLabel("Webhook delivery URL", { exact: true })
    .fill("https://hooks.example.test/linear");
  await submit.click();
  await connected(page);
  await page
    .getByRole("region", { name: "API key", exact: true })
    .scrollIntoViewIfNeeded();
  await harness.snap(page, `${label}-connected-protocol-test`, {
    fullPage: false,
  });
  check(
    (await key.inputValue()) === "",
    `${label}: successful authorization clears the credential draft`,
  );
  check(
    (
      await page
        .getByRole("region", {
          name: "Linear connection status",
          exact: true,
        })
        .innerText()
    ).includes("Browser contract workspace"),
    `${label}: provider-confirmed workspace is shown`,
  );
  return { key, submit, iconSource };
}

async function verifyOperations(harness, page, label, authority) {
  const { check } = harness;
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  check(
    layout.content <= layout.width,
    `${label}: verified account and operations do not overflow horizontally`,
  );
  await page
    .getByRole("button", { name: "Read Linear issues", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Linear issues", exact: true })
    .getByText(/TEST-42/)
    .waitFor();
  check(
    true,
    `${label}: authenticated provider issues reach the rendered result`,
  );
  await page
    .getByRole("button", { name: "Read Linear projects", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Linear projects", exact: true })
    .getByText("Protocol contract project", { exact: true })
    .waitFor();
  check(
    true,
    `${label}: authenticated provider projects reach the rendered result`,
  );
  await page.getByText("Create a Linear issue", { exact: true }).click();
  await page
    .getByRole("button", { name: "Load Linear teams", exact: true })
    .click();
  await page.getByLabel("Linear team", { exact: true }).waitFor();
  await page
    .getByLabel("Issue title", { exact: true })
    .fill(`${label} browser-created issue`);
  await page
    .getByLabel("Issue description", { exact: true })
    .fill("Created by the browser protocol integration contract.");
  await page
    .getByRole("button", { name: "Create issue in Linear", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Issue created in Linear", exact: true })
    .waitFor();
  check(
    authority.issueTitle === `${label} browser-created issue`,
    `${label}: issue creation reaches the provider mutation with entered text`,
  );
  await page
    .getByRole("region", { name: "Issue created in Linear", exact: true })
    .getByRole("link")
    .first()
    .scrollIntoViewIfNeeded();
  await harness.snap(page, `${label}-verified-protocol-test`, {
    fullPage: false,
  });
}

async function verifyPersisted(
  { harness, visit },
  page,
  label,
  { key, iconSource },
) {
  const { check } = harness;
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await visit(page, "connections/linear");
  await connected(page);
  check(
    (await key.inputValue()) === "",
    `${label}: sealed credential is never filled into the reloaded input`,
  );
  check(
    (await page
      .getByRole("img", { name: "Connector icon", exact: true })
      .getAttribute("src")) === iconSource,
    `${label}: provider icon survives sealed reload`,
  );
  await page
    .getByRole("button", { name: "Read Linear issues", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Linear issues", exact: true })
    .waitFor();
  check(
    true,
    `${label}: reloaded sealed credential authenticates an operation`,
  );
  check(
    !JSON.stringify(
      await page.evaluate(() => Object.entries(localStorage)),
    ).includes(LINEAR_TEST_KEY),
    `${label}: credential is absent from browser-local plaintext storage`,
  );
  const sealedStorage = await page.evaluate(async (secret) => {
    const found = [];
    async function walk(directory) {
      for await (const handle of directory.values()) {
        if (handle.kind === "directory") await walk(handle);
        else {
          const file = await handle.getFile();
          found.push({
            name: handle.name,
            plaintext: (await file.text()).includes(secret),
          });
        }
      }
    }
    await walk(await navigator.storage.getDirectory());
    return found;
  }, LINEAR_TEST_KEY);
  check(
    sealedStorage.length > 0 && sealedStorage.every((file) => !file.plaintext),
    `${label}: persistent browser files contain no plaintext provider key`,
  );
}

async function verifyEditAndRemove(
  { harness, visit },
  page,
  label,
  authority,
  submit,
) {
  const { check } = harness;
  await page
    .getByLabel("Connector Name", { exact: true })
    .fill(`${label}-linear-edited`);
  await submit.click();
  await connected(page);
  check(
    (await page.getByLabel("Connector Name", { exact: true }).inputValue()) ===
      `${label}-linear-edited`,
    `${label}: blank credential retains its verified key for metadata edits`,
  );
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await page
    .getByRole("img", { name: "Linear connected", exact: true })
    .waitFor({ state: "detached" });
  check(
    authority.calls.some(({ body }) =>
      body?.query.includes("OpenSesameDeleteWebhook"),
    ),
    `${label}: removal deletes its provider webhook before local removal`,
  );
  await visit(page, "connections/slack");
  check(
    !/Expected Linear workspace|Vercel access token|Team ID|Project ID/.test(
      await page.locator("main").innerText(),
    ),
    `${label}: provider navigation does not retain Linear settings`,
  );
}

async function verifyWebhookSecret(harness, page, label, authority) {
  const mutation = authority.calls.find(({ body }) =>
    body?.query.includes("OpenSesameWebhook("),
  );
  const secret = mutation?.body.variables.input.secret;
  await page
    .getByRole("button", { name: "Copy webhook signing secret", exact: true })
    .click();
  await page
    .getByRole("img", { name: "Signing secret copied", exact: true })
    .first()
    .waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  harness.check(
    isString(secret) && copied === secret,
    `${label}: explicit clipboard action retrieves the provider's exact signing secret`,
  );
  harness.check(
    !(await page.locator("body").innerText()).includes(copied),
    `${label}: signing secret is absent from rendered text`,
  );
}

export async function apiKeyFlow(dependencies, page, label, authority) {
  const fields = await verifyApiKey(dependencies, page, label);
  await verifyWebhookSecret(dependencies.harness, page, label, authority);
  await verifyOperations(dependencies.harness, page, label, authority);
  await verifyPersisted(dependencies, page, label, fields);
  await verifyEditAndRemove(
    dependencies,
    page,
    label,
    authority,
    fields.submit,
  );
}
export async function oauthFlow(harness, page, label, authority) {
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
  await page
    .getByRole("button", { name: "Create and authorize Linear", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  check(
    new URL(page.url()).searchParams.get("actor") === "app",
    `${label}: app consent begins first`,
  );
  const deniedState = new URL(page.url()).searchParams.get("state");
  await authority.deny(page);
  await unlockWithPin(page);
  await page
    .getByRole("img", { name: "Linear authorization incomplete", exact: true })
    .waitFor();
  check(
    (await page
      .getByRole("img", { name: "Linear connected", exact: true })
      .count()) === 0,
    `${label}: declined OAuth consent never activates the connector`,
  );
  await page
    .getByRole("button", { name: "Authorize application", exact: true })
    .click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  check(
    new URL(page.url()).searchParams.get("state") !== deniedState,
    `${label}: retry after decline creates a fresh authorization transaction`,
  );
  await authority.consent(page, "browser-app-code");
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL("https://linear.app/oauth/authorize?**");
  check(
    new URL(page.url()).searchParams.get("actor") === "user",
    `${label}: user scopes require independent user consent`,
  );
  await authority.consent(page, "browser-user-code");
  await unlockWithPin(page);
  await connected(page);
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
