import { expect } from "@playwright/test";

export const SIOP_RP = "https://rp.example.test";
export const SIOP_CALLBACK = `${SIOP_RP}/callback`;

const VIEW = {
  person: "people",
  organization: "organizations",
  application: "applications",
};

export async function tabTo(page, target, key = "Tab") {
  for (let step = 0; step < 80; step++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  throw new Error("Keyboard could not reach target");
}

export async function installWebAuthn(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { cdp, authenticatorId };
}

export async function continueAsGuest(page, origin, base) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "New item", exact: true }),
  ).toBeVisible();
}

async function identityPanel(page, kind) {
  const view = VIEW[kind];
  return page.getByRole("region", {
    name: `Local ${view}`,
    exact: true,
  });
}

export async function createIdentityEntry(page, origin, base, kind, name) {
  await page.goto(`${origin}${base}identity?view=${VIEW[kind]}`, {
    waitUntil: "networkidle",
  });
  const panel = await identityPanel(page, kind);
  await panel.getByRole("button", { name: `New ${kind}`, exact: true }).click();
  const field = page.getByRole("textbox", { name: "Name", exact: true });
  await field.fill(name);
  await field.press("Enter");
  await expect(panel.getByRole("heading", { name, exact: true })).toBeVisible();
  const row = panel.getByRole("listitem").filter({ hasText: name });
  const id =
    (await row.locator("code.identity-ref").textContent())?.trim() ?? "";
  if (!/^local_[0-9a-f-]{36}$/.test(id)) {
    throw new Error(`Expected local application id, got ${JSON.stringify(id)}`);
  }
  return { row, id };
}

export async function assignOrganizationOwner(page, orgRow, personName) {
  await orgRow.locator("summary", { hasText: "Members" }).click();
  const person = orgRow.getByRole("combobox", { name: "Person or agent" });
  await person.selectOption({ label: personName });
  await orgRow.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(orgRow.getByText(personName)).toBeVisible();
  await expect(orgRow).toContainText("Owner (operator)");
}

export async function enrollPersonPasskey(page, personRow) {
  await personRow.locator("summary", { hasText: "Passkeys" }).click();
  await personRow
    .getByRole("button", { name: "Enroll passkey", exact: true })
    .click();
  await expect(
    personRow.getByRole("status", { name: "Passkey status" }),
  ).toContainText("Passkey enrolled.");
}

export async function registerApplication(page, appRow, organizationName) {
  await appRow
    .locator("summary", { hasText: "Application registration" })
    .click();
  await appRow
    .getByRole("combobox", { name: "Organization", exact: true })
    .selectOption({ label: organizationName });
  await appRow
    .getByRole("textbox", { name: "Redirect URIs (one per line)", exact: true })
    .fill(SIOP_CALLBACK);
  await appRow
    .getByRole("textbox", {
      name: "Allowed scopes (space separated)",
      exact: true,
    })
    .fill("openid");
  await appRow
    .getByRole("button", { name: "Save registration", exact: true })
    .click();
  await expect(
    appRow.getByText(
      "Registered locally. Access still requires authorization.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
}

export function siopIssuer(origin, base) {
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${origin}${root}identity/siop`.replace(/\/$/, "");
}

export function buildSiopUrl(origin, base, clientId, { nonce, state }) {
  const params = new URLSearchParams();
  params.set("response_type", "id_token");
  params.set("client_id", clientId);
  params.set("redirect_uri", SIOP_CALLBACK);
  params.set("scope", "openid");
  params.set("nonce", nonce);
  params.set("response_mode", "fragment");
  if (state !== undefined && state !== null) params.set("state", state);
  return `${origin}${base}identity/siop?${params.toString()}`;
}

export async function approveSiopConsent(page, personName) {
  await expect(
    page.getByRole("heading", { name: /Self-issued sign-in to/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByLabel("Person", { exact: true })
    .selectOption({ label: personName });
  await page
    .getByRole("button", { name: "Verify with passkey", exact: true })
    .click();
  const allow = page.getByRole("button", {
    name: "Allow Self-Issued sign-in",
    exact: true,
  });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await Promise.all([waitForRpNavigation(page), allow.click()]);
  return page.url();
}

export async function denySiopConsent(page) {
  await expect(
    page.getByRole("heading", { name: /Self-issued sign-in to/ }),
  ).toBeVisible({ timeout: 30_000 });
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(deny).toBeVisible({ timeout: 30_000 });
  await Promise.all([waitForRpNavigation(page), deny.click()]);
  return page.url();
}

export async function waitForRpNavigation(page, timeout = 15_000) {
  await page.waitForURL(
    (url) =>
      url.origin === SIOP_RP &&
      url.pathname === "/callback" &&
      url.hash.length > 1,
    { timeout },
  );
  return page.url();
}
