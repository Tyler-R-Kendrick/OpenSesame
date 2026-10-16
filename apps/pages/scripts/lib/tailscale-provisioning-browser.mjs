import { readFile } from "node:fs/promises";
/** Conditional direct-HTTP evidence: real sockets/UI; ONLY hosted consent is synthetic. */
async function ready(page) {
  await page
    .getByRole("button", { name: "Authorize a device with Tailscale" })
    .waitFor();
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          'button[aria-label="Authorize a device with Tailscale"]',
        )?.disabled,
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => {
        const button = document.querySelector(
          'button[aria-label="Authorize a device with Tailscale"]',
        );
        return {
          disabled: button?.disabled ?? null,
          busy: [...document.querySelectorAll("[aria-busy]")].map(
            (node) => node.getAttribute("aria-label"),
          ),
          text: document.body.innerText.slice(0, 2000),
        };
      });
      throw new Error(
        `Authorize never enabled: ${JSON.stringify(state)}`,
        { cause: error },
      );
    });
}
async function consent(page, fixture, mode, cancel = false) {
  fixture.setNextConsent(mode);
  const popupPromise = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Authorize a device with Tailscale" })
    .click();
  const popup = await popupPromise;
  await popup.getByRole("link", { name: "Approve fixture device" }).waitFor();
  if (cancel)
    await page
      .getByRole("button", { name: "Cancel Tailscale operation" })
      .first()
      .click();
  else {
    await popup.getByRole("link", { name: "Approve fixture device" }).click();
    if (mode === "wrong-state") {
      await popup.waitForURL(
        (url) => url.origin === new URL(page.url()).origin,
      );
      // A mismatched callback must not settle the reserved genuine consent.
      // Cancel through the actual UI after observing the rejected return.
      await page
        .getByRole("button", { name: "Cancel Tailscale operation" })
        .first()
        .click();
    }
  }
  await ready(page);
}
async function register(page, fixture, apiBase, check) {
  await page
    .getByLabel("Tailscale API base URL", { exact: true })
    .fill(apiBase);
  await page.getByText("Direct API registration", { exact: true }).click();
  await page
    .getByLabel("Admin API access token", { exact: true })
    .fill(fixture.adminToken);
  await page
    .getByRole("button", { name: "Register app with Tailscale" })
    .click();
  await page.getByLabel("Registered client ID", { exact: true }).waitFor();
  await page
    .getByText("Direct API device authorization", { exact: true })
    .click();
  await ready(page);
  check(
    "Tailscale real socket app creation and verification",
    fixture.stats.registrations === 1 && fixture.stats.verifications === 1,
  );
  const values = await page
    .locator("input")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  check(
    "Tailscale generated client secret is absent from rendered inputs",
    !values.includes(fixture.app.clientSecret),
  );
  check(
    "Tailscale bootstrap admin token is cleared",
    (await page
      .getByLabel("Admin API access token", { exact: true })
      .count()) === 0,
  );
}
async function issueAndClear({ page, fixture, check, lockAndUnlock }) {
  await consent(page, fixture, "wrong-state");
  check(
    "Tailscale wrong state prevents token exchange",
    fixture.stats.exchanges === 0 &&
      (await page
        .getByLabel("Single-use auth key", { exact: true })
        .count()) === 0,
  );
  await consent(page, fixture, "accept", true);
  check(
    "Tailscale cancelling pending consent issues no device key",
    fixture.stats.exchanges === 0 &&
      (await page
        .getByLabel("Single-use auth key", { exact: true })
        .count()) === 0,
  );
  await consent(page, fixture, "accept");
  const control = page.getByLabel("Single-use auth key", { exact: true });
  await control.waitFor();
  const key = await control.inputValue();
  check(
    "Tailscale consent exchange returns actual one-use fixture key",
    fixture.stats.exchanges === 1 &&
      fixture.consumeDeviceKey(key) &&
      !fixture.consumeDeviceKey(key),
  );
  check(
    "Tailscale device key is concealed",
    (await control.getAttribute("type")) === "password",
  );
  if (lockAndUnlock) await lockAndUnlock();
  else
    await page.getByRole("button", { name: "Dismiss device auth key" }).click();
  check(
    "Tailscale lock or dismissal clears issued device key",
    (await page.getByLabel("Single-use auth key", { exact: true }).count()) ===
      0,
  );
}
export async function exerciseTailscaleProvisioning(options) {
  const { page, fixture, apiBase, check } = options;
  await register(page, fixture, apiBase, check);
  await issueAndClear(options);
}
/** Separate new-vault road: real denied CORS preflight, then entirely local user handoff. */
export async function exerciseTailscaleBrowserOnlyHandoff({
  page,
  fixture,
  apiBase,
  check,
}) {
  fixture.setCorsEnabled(false);
  await page
    .getByLabel("Tailscale API base URL", { exact: true })
    .fill(apiBase);
  await page.getByText("Direct API registration", { exact: true }).click();
  await page
    .getByLabel("Admin API access token", { exact: true })
    .fill(fixture.adminToken);
  await page
    .getByRole("button", { name: "Register app with Tailscale" })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector(
        'button[aria-label="Register app with Tailscale"]',
      )?.disabled,
  );
  check(
    "Tailscale CORS refusal creates no app and clears bootstrap token",
    fixture.stats.registrations === 0 &&
      (await page
        .getByLabel("Admin API access token", { exact: true })
        .inputValue()) === "",
  );
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download registration request" })
    .click();
  const download = await downloadPromise;
  const artifact = await checkArtifact(download, check);
  const app = fixture.seedRegisteredApp({
    name: artifact.request.name,
    redirectUri: artifact.request.redirectUris[0],
  });
  await page
    .getByLabel("Returned OAuth app JSON", { exact: true })
    .fill(JSON.stringify(app));
  await page
    .getByRole("button", { name: "Save returned Tailscale app" })
    .click();
  await page.getByLabel("Registered client ID", { exact: true }).waitFor();
  check(
    "Tailscale returned credentials are saved locally without vendor verification",
    fixture.stats.registrations === 0 &&
      fixture.stats.exchanges === 0 &&
      (await page
        .getByLabel("Registered client ID", { exact: true })
        .inputValue()) === app.id,
  );
  await page
    .getByLabel("Issued device auth key", { exact: true })
    .fill("fixture-user-issued-auth-key");
  await page
    .getByRole("button", { name: "Prepare device key handoff" })
    .click();
  const key = page.getByLabel("Unverified device auth key", { exact: true });
  await key.waitFor();
  check(
    "Tailscale local handoff is concealed and unverified without a network request",
    (await key.getAttribute("type")) === "password" &&
      fixture.stats.registrations === 0 &&
      fixture.stats.exchanges === 0,
  );
  await page.getByRole("button", { name: "Dismiss device auth key" }).click();
  fixture.setCorsEnabled(true);
}

async function checkArtifact(download, check) {
  const path = await download.path();
  if (!path) throw new Error("Registration artifact was not downloaded");
  const text = await readFile(path, "utf8");
  const artifact = JSON.parse(text);
  check(
    "Tailscale registration artifact downloads without client credentials",
    download.suggestedFilename() === "tailscale-registration.json" &&
      artifact.deploymentId &&
      artifact.request.scopes.join(" ") === "auth_keys:create:once" &&
      !text.includes("clientSecret") &&
      !text.includes("client_id"),
  );
  return artifact;
}
