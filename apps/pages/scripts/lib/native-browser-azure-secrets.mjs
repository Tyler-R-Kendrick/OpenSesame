/** Documented Azure secret list/get only; synthetic credentials, never hosted account proof. */
import { expect } from "@playwright/test";
import { nativeVerifiedCapture } from "./native-browser-api-lifecycle.mjs";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import { unlockWithPin } from "./pages-journey.mjs";

// https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secrets/get-secrets
// https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret
export const AZURE_SECRETS_FIXTURE = Object.freeze({
  providerId: "azure-sm",
  name: "Azure Key Vault Secrets",
  vaultURL: "https://owned.vault.azure.net",
  apiVersion: "2025-07-01",
  token: "browser-protocol-only-key-vault-token",
  secretName: "api-key",
  value: "browser-protocol-only-secret-value",
  version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
export function azureBrowserReplies() {
  const f = AZURE_SECRETS_FIXTURE;
  return {
    page: {
      value: [
        {
          id: `${f.vaultURL}/secrets/${f.secretName}`,
          tags: { private: "private Azure fixture metadata" },
        },
      ],
      nextLink: null,
    },
    bundle: {
      id: `${f.vaultURL}/secrets/${f.secretName}/${f.version}`,
      value: f.value,
    },
  };
}
export async function routeNativeAzureSecretsAuthority(
  context,
  authority,
  harness,
) {
  const f = AZURE_SECRETS_FIXTURE;
  const list = `${f.vaultURL}/secrets?api-version=${f.apiVersion}&maxresults=25`;
  const get = `${f.vaultURL}/secrets/${f.secretName}?api-version=${f.apiVersion}`;
  await context.route(
    (url) => url.origin === f.vaultURL,
    async (route) => {
      const request = route.request();
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET",
        "access-control-allow-headers": "Authorization,Accept",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: cors });
      const headers = await request.allHeaders();
      const exact =
        [list, get].includes(request.url()) &&
        request.method() === "GET" &&
        request.postData() === null &&
        !headers.cookie &&
        headers.accept === "application/json";
      if (!exact) return route.fallback();
      const accepted =
        headers.authorization === `Bearer ${f.token}` &&
        !authority.state.reject.has(f.providerId);
      const status = accepted ? 200 : 401;
      const body = accepted
        ? azureBrowserReplies()[request.url() === list ? "page" : "bundle"]
        : {
            error: {
              code: "Unauthorized",
              message: "Synthetic Key Vault token refusal",
            },
          };
      authority.state.calls.push({
        providerId: f.providerId,
        method: "GET",
        purpose: request.url() === list ? "shared" : "resource",
        operation:
          request.url() === list
            ? "provider.secrets.read"
            : "provider.secret.read",
      });
      harness.check(
        !headers.cookie,
        "azure-sm: Key Vault requests omit cookies",
      );
      if (status !== 200)
        authority.state.expectedResponses.set(request, status);
      return route.fulfill({
        status,
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}
async function azureListNames(page, harness, authority) {
  await page
    .getByText("List secret names", { selector: "summary", exact: true })
    .click();
  const before = authority.state.calls.length;
  await page
    .getByRole("button", { name: "List secret names", exact: true })
    .click();
  const result = page.getByRole("region", {
    name: "Showing 1 secret names from first page",
    exact: true,
  });
  await expect(result).toBeVisible();
  await expect(result.getByRole("listitem")).toHaveText([
    AZURE_SECRETS_FIXTURE.secretName,
  ]);
  harness.check(
    authority.state.calls.length > before,
    "azure-sm: List secret names issues its actual fixed native request",
  );
  harness.check(
    !(await result.innerText()).includes("private Azure fixture metadata"),
    "azure-sm: list projection omits private provider tags",
  );
}
async function azureReadValue(page, harness, authority) {
  const f = AZURE_SECRETS_FIXTURE;
  await page
    .getByText("Read a secret", { selector: "summary", exact: true })
    .click();
  await page
    .getByLabel("Secret name or versioned ID", { exact: true })
    .fill(f.secretName);
  const before = authority.state.calls.length;
  await page
    .getByRole("button", { name: "Read a secret", exact: true })
    .click();
  const value = page.getByRole("region", {
    name: "Secret read once",
    exact: true,
  });
  await expect(value).toBeVisible();
  harness.check(
    !(await value.innerText()).includes(f.value),
    "azure-sm: explicit get result starts masked",
  );
  await value
    .getByRole("button", { name: "Reveal api-key", exact: true })
    .click();
  await expect(value).toContainText(f.value);
  harness.check(
    authority.state.calls.length > before &&
      authority.state.calls.at(-1).operation === "provider.secret.read",
    "azure-sm: revealed value came from the actual GET secret request",
  );
  await value
    .getByRole("button", { name: "Hide api-key", exact: true })
    .click();
}
async function azureRemoveAndReload(page, harness, authority) {
  const f = AZURE_SECRETS_FIXTURE;
  const before = authority.state.calls.length;
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "List secret names", exact: true }),
  ).toHaveCount(0);
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await expect(
    page.getByLabel("Key Vault access token", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Read a secret", exact: true }),
  ).toHaveCount(0);
  harness.check(
    authority.state.calls.length === before,
    "azure-sm: local removal and cold absence issue no provider delete or token reuse",
  );
  harness.check(
    !(await page.locator("body").innerText()).includes(f.value),
    "azure-sm: removed secret result stays absent after reload",
  );
}
export async function nativeAzureSecretsJourney(
  page,
  harness,
  authority,
  { base, out, label },
) {
  const f = AZURE_SECRETS_FIXTURE;
  harness.setStep(`${label}-azure-secrets`);
  await nativeVisit(page, base, "settings/connections/azure-sm");
  const token = page.getByLabel("Key Vault access token", { exact: true });
  const vault = page.getByLabel("Vault URL", { exact: true });
  const submit = page.getByRole("button", {
    name: "Verify and connect Azure Key Vault Secrets",
    exact: true,
  });
  await expect(vault).toBeVisible();
  await vault.fill(f.vaultURL);
  await token.fill("browser-protocol-only-invalid-key-vault-token");
  let before = authority.state.calls.length;
  await submit.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(submit).toBeEnabled();
  harness.check(
    (await page
      .getByRole("button", { name: "Remove connector", exact: true })
      .count()) === 0,
    "azure-sm: refused token never saves a connector",
  );
  await token.fill(f.token);
  await submit.click();
  await expect(
    page.getByRole("button", { name: "List secret names", exact: true }),
  ).toHaveCount(1);
  await expect(token).toHaveValue("");
  harness.check(
    !(await page.locator("body").innerText()).includes(f.token),
    "azure-sm: saved Key Vault token never renders as prose",
  );
  await azureListNames(page, harness, authority);
  await azureReadValue(page, harness, authority);
  await nativeVerifiedCapture(
    page,
    `${out}/${label}-azure-secrets-verified.png`,
  );
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await expect(token).toHaveValue("");
  await expect(vault).toHaveValue(f.vaultURL);
  harness.check(
    !(await page.locator("body").innerText()).includes(f.value),
    "azure-sm: fetched secret value does not survive cold reload",
  );
  before = authority.state.calls.length;
  await submit.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(submit).toBeEnabled();
  await azureListNames(page, harness, authority);
  await azureRemoveAndReload(page, harness, authority);
  return {
    providerId: f.providerId,
    connected: true,
    readAfterReload: true,
    secretGet: true,
    removed: true,
    coldAbsent: true,
    assurance:
      "synthetic documented Key Vault list/get; no hosted account, CRUD, backup or token issuance proof",
  };
}
