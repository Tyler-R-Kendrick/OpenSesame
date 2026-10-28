/** Real socket browser journeys; provider requests remain actual network traffic. */
import { expect } from "@playwright/test";
import { observeBitwardenSdkResources } from "./bitwarden-sdk-resource.mjs";
import { observeHttpFailures } from "./http-failures.mjs";
import { allowLoopbackDevelopment } from "./local-network-permission.mjs";
import { unlockWithPin } from "./pages-journey.mjs";
import {
  FIXTURE_SCOPE,
  FIXTURE_TOKEN,
} from "./secret-backend-fixture-http.mjs";
import { INFISICAL_CLIENT } from "./secret-backend-infisical-fixture.mjs";

export async function newBackendPage(
  browser,
  {
    width,
    origin,
    providers,
    record,
    serviceWorkers = "block",
    requestFailures,
  },
) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile: width === 390,
    hasTouch: width === 390,
    serviceWorkers,
  });
  observeBitwardenSdkResources(context, origin, record);
  const allowed = new Set([origin, ...providers]);
  context.on("request", (request) => {
    requestFailures?.observe(request);
    const url = new URL(request.url());
    if (!["blob:", "data:"].includes(url.protocol) && !allowed.has(url.origin))
      record("unexpected-external-request", url.href);
  });
  context.on("requestfailed", (request) => {
    record(
      requestFailures?.expected(request)
        ? "expected-offline-app-request"
        : "network-failure",
      `${request.failure()?.errorText}: ${request.url()}`,
    );
  });
  const page = await context.newPage();
  observeHttpFailures(page, record);
  page.on("pageerror", (error) =>
    record("PAGE-ERROR", String(error.stack ?? error)),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      record("console-error", `${message.text()} ${message.location().url}`);
  });
  await allowLoopbackDevelopment(page, origin);
  await page.addInitScript(() => {
    window.__officialSaveActivations = 0;
    document.addEventListener("OPButtonAdded", () => {
      window.__officialSaveActivations++;
    });
  });
  return { page, context };
}

export async function visitBackendRoute(page, base, route) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}
export async function enableBackendConnections(page, base) {
  await visitBackendRoute(page, base, "settings/features");
  const toggle = page.getByRole("switch", { name: "Connections", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
}
export async function openBackend(page, base, preset) {
  await visitBackendRoute(
    page,
    base,
    `settings/connections/${preset.providerId}`,
  );
  await page
    .getByRole("heading", { name: preset.label, exact: true })
    .waitFor();
  await page.getByLabel("Connection method", { exact: true }).waitFor();
}
export async function saveBackend(page) {
  await page
    .getByRole("button", { name: "Save secret backend", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect saved secret backend", exact: true })
    .waitFor();
}
export async function connectBackend(page) {
  await page
    .getByRole("button", { name: "Connect saved secret backend", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Secret backend items", exact: true })
    .waitFor({ timeout: 30_000 });
}
export async function disconnectBackend(page) {
  await page
    .getByRole("button", { name: "Disconnect secret backend", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Secret backend items", exact: true }),
  ).toHaveCount(0);
}
export async function fillNativeBackend(page, fixture, mode, width) {
  await page
    .getByLabel("Connection name", { exact: true })
    .fill(`${fixture.name} ${width}`);
  await page.getByLabel("API base URL", { exact: true }).fill(fixture.origin);
  if (mode === "bitwarden-api") {
    const credentials = fixture.credentials;
    for (const [label, value] of [
      ["API base URL", credentials.baseUrl],
      ["Identity API URL", credentials.identityUrl],
      ["Account email", credentials.email],
      ["Personal API client ID", credentials.clientId],
      ["Personal API client secret", credentials.clientSecret],
      ["Device identifier", credentials.deviceIdentifier],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
  }
  if (mode === "onepassword-connect") {
    await page.getByLabel("Access token", { exact: true }).fill(FIXTURE_TOKEN);
    await page
      .getByLabel("Vault ID", { exact: true })
      .fill(FIXTURE_SCOPE.vaultId);
  }
  if (mode === "infisical") {
    await page
      .getByLabel("Project ID", { exact: true })
      .fill(FIXTURE_SCOPE.projectId);
    await page
      .getByLabel("Environment", { exact: true })
      .fill(FIXTURE_SCOPE.environment);
    await page
      .getByLabel("Secret path", { exact: true })
      .fill(FIXTURE_SCOPE.secretPath);
    await page.getByText("Universal Auth", { exact: true }).click();
    await page
      .getByLabel("Client ID", { exact: true })
      .fill(INFISICAL_CLIENT.id);
    await page
      .getByLabel("Client secret", { exact: true })
      .fill(INFISICAL_CLIENT.secret);
  }
  if (mode === "passwordstate") {
    await page.getByLabel("API key", { exact: true }).fill(FIXTURE_TOKEN);
    await page
      .getByLabel("Password list ID", { exact: true })
      .fill(FIXTURE_SCOPE.passwordListId);
  }
}
export async function savedBackendReload(
  page,
  { base, preset, fixture, width, check },
) {
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await openBackend(page, base, preset);
  await expect(page.getByLabel("Connection name", { exact: true })).toHaveValue(
    `${fixture.name} ${width}`,
  );
  await expect(page.getByLabel("API base URL", { exact: true })).toHaveValue(
    fixture.credentials?.baseUrl ?? fixture.origin,
  );
  await expect(
    page.getByRole("region", { name: "Secret backend items", exact: true }),
  ).toHaveCount(0);
  check(
    true,
    `${width}: ${preset.providerId} configuration survives cold reload while its volatile session does not`,
  );
}

export async function backendCrud(page, { name, kind, origin, check, width }) {
  const initial = {
    notes: `Browser notes for ${name}\nsecond line`,
    secret: `browser-secret-${name}`,
  };
  const updated = {
    notes: `Updated notes for ${name}`,
    secret: `browser-secret-updated-${name}`,
  };
  const secret = page.getByLabel(
    kind === "login" ? "Password" : "Secret value",
    { exact: true },
  );
  await page
    .getByRole("button", { name: "New backend item", exact: true })
    .click();
  await page.getByLabel("Item type", { exact: true }).selectOption(kind);
  await page.getByLabel("Item name", { exact: true }).fill(name);
  await page.getByLabel("Notes", { exact: true }).fill(initial.notes);
  if (kind !== "note") await secret.fill(initial.secret);
  if (kind === "login") {
    await page.getByLabel("Username", { exact: true }).fill("fixture-user");
    await page.getByLabel("Website", { exact: true }).fill(origin);
  }
  await page
    .getByRole("button", { name: "Create backend item", exact: true })
    .click();
  const open = page.getByRole("button", {
    name: `Open backend item ${name}`,
    exact: true,
  });
  await open.waitFor();
  await page
    .getByRole("button", { name: `Read notes for ${name}`, exact: true })
    .click();
  await expect(page.getByLabel("Backend notes", { exact: true })).toHaveValue(
    initial.notes,
  );
  await open.click();
  if (kind !== "note") await expect(secret).toHaveValue(initial.secret);
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(
    initial.notes,
  );
  check(
    true,
    `${width}: ${name} create/list/get/getNotes return real stored values`,
  );
  await page
    .getByRole("button", { name: "Edit backend item", exact: true })
    .click();
  if (kind !== "note") {
    await expect(secret).toBeEditable();
    await secret.fill(updated.secret);
  }
  await page.getByLabel("Notes", { exact: true }).fill(updated.notes);
  await page
    .getByRole("button", { name: "Update backend item", exact: true })
    .click();
  await page
    .getByRole("img", { name: "Backend item saved", exact: true })
    .waitFor();
  await open.click();
  if (kind !== "note") await expect(secret).toHaveValue(updated.secret);
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(
    updated.notes,
  );
  check(true, `${width}: ${name} update is visible through a new backend read`);
  await page
    .getByRole("button", { name: "Delete backend item", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm delete backend item", exact: true })
    .click();
  await expect(open).toHaveCount(0);
  check(true, `${width}: ${name} confirmed delete removes the stored item`);
}
