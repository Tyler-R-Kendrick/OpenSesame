/** Official token lookup-self response shape; synthetic self-hosted instance credentials. */
import { expect } from "@playwright/test";
import { nativeVerifiedCapture } from "./native-browser-api-lifecycle.mjs";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import { unlockWithPin } from "./pages-journey.mjs";

export const NATIVE_INSTANCE_FIXTURES = [
  { id: "vault", name: "HashiCorp Vault", entity: "" },
  { id: "openbao", name: "OpenBao", entity: "browser-protocol-entity" },
].map((fixture) => ({
  ...fixture,
  origin: `https://${fixture.id}.browser-protocol.example`,
  namespace: "team-browser",
  token: `browser-protocol-only-${fixture.id}`,
  documentation:
    fixture.id === "vault"
      ? "https://developer.hashicorp.com/vault/api-docs/auth/token#lookup-a-token-self"
      : "https://openbao.org/api-docs/auth/token/#lookup-a-token-self",
}));

export async function routeNativeInstanceAuthority(
  context,
  authority,
  harness,
) {
  for (const fixture of NATIVE_INSTANCE_FIXTURES) {
    await context.route(
      (url) => url.origin === fixture.origin,
      async (route) => {
        const request = route.request();
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST",
          "access-control-allow-headers": "X-Vault-Token,X-Vault-Namespace",
        };
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers: cors });
        const headers = await request.allHeaders();
        harness.check(
          request.url() === `${fixture.origin}/v1/auth/token/lookup-self`,
          `${fixture.id}: token verification uses only fixed lookup-self route`,
        );
        harness.check(
          request.method() === "GET",
          `${fixture.id}: token lookup is GET`,
        );
        harness.check(
          headers["x-vault-token"] === fixture.token,
          `${fixture.id}: actual human token reaches the provider header`,
        );
        harness.check(
          headers["x-vault-namespace"] === fixture.namespace,
          `${fixture.id}: namespace reaches the provider header`,
        );
        harness.check(
          !headers.cookie,
          `${fixture.id}: verification omits cookies`,
        );
        authority.state.calls.push({
          providerId: fixture.id,
          method: request.method(),
        });
        const status = authority.state.reject.has(fixture.id) ? 401 : 200;
        if (status !== 200)
          authority.state.expectedResponses.set(request, status);
        return route.fulfill({
          status,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify(
            status === 200
              ? {
                  data: {
                    display_name: "Synthetic restricted token",
                    entity_id: fixture.entity,
                    policies: ["default", "browser-read"],
                    ttl: 3600,
                    renewable: true,
                  },
                }
              : { errors: ["Synthetic invalid token"] },
          ),
        });
      },
    );
  }
}

async function fillInstance(page, fixture) {
  await page
    .locator("summary")
    .filter({ hasText: /^Sign-in options$/ })
    .click();
  await page
    .getByLabel("Instance HTTPS origin", { exact: true })
    .fill(fixture.origin);
  await page
    .getByLabel("Namespace (optional)", { exact: true })
    .fill(fixture.namespace);
  await page.getByLabel("Provider token", { exact: true }).fill(fixture.token);
}

async function removeInstance(page, harness, authority, fixture) {
  const before = authority.state.calls.length;
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm remove connector", exact: true }),
  ).toHaveCount(0);
  harness.check(
    authority.state.calls.length === before,
    `${fixture.id}: normal disconnect forgets the local token without provider-wide revocation`,
  );
}

export async function nativeInstanceJourney(
  page,
  harness,
  authority,
  fixture,
  { base, out, label },
) {
  harness.setStep(`${label}-instance-${fixture.id}`);
  await nativeVisit(page, base, `connections/${fixture.id}`);
  await page
    .getByRole("heading", { name: fixture.name, exact: true })
    .waitFor();
  await page
    .getByRole("radio", { name: `${fixture.name} token`, exact: true })
    .check();
  const submit = page.getByRole("button", {
    name: `Verify and connect ${fixture.name}`,
    exact: true,
  });
  harness.check(
    (await submit.count()) === 1,
    `${fixture.id}: supported self-hosted driver offers verified connection`,
  );
  await page.screenshot({
    path: `${out}/${label}-${fixture.id}-configure.png`,
    fullPage: false,
  });
  await fillInstance(page, fixture);
  authority.state.reject.add(fixture.id);
  let before = authority.state.calls.length;
  await submit.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(submit).toBeEnabled();
  harness.check(
    (await page
      .getByRole("button", { name: "Remove connector", exact: true })
      .count()) === 0,
    `${fixture.id}: rejected token creates no connected record`,
  );
  authority.state.reject.delete(fixture.id);
  await submit.click();
  const status = page.getByRole("img", {
    name: `${fixture.name} ${fixture.entity ? "connected" : "access verified"}`,
    exact: true,
  });
  await status.waitFor();
  harness.check(
    (await page.getByLabel("Provider token", { exact: true }).inputValue()) ===
      "",
    `${fixture.id}: verified save clears entered token`,
  );
  harness.check(
    !(await page.locator("body").innerText()).includes(fixture.token),
    `${fixture.id}: provider token never appears in rendered prose`,
  );
  await nativeVerifiedCapture(
    page,
    `${out}/${label}-${fixture.id}-verified.png`,
  );
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await status.waitFor();
  before = authority.state.calls.length;
  const verify = page.getByRole("button", {
    name: `Verify ${fixture.name} access`,
    exact: true,
  });
  await verify.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(verify).toBeEnabled();
  harness.check(
    (await page
      .getByLabel("Instance HTTPS origin", { exact: true })
      .inputValue()) === fixture.origin,
    `${fixture.id}: instance origin survives encrypted reload`,
  );
  harness.check(
    (await page
      .getByLabel("Namespace (optional)", { exact: true })
      .inputValue()) === fixture.namespace,
    `${fixture.id}: namespace stays paired with its sealed token`,
  );
  await removeInstance(page, harness, authority, fixture);
  return {
    providerId: fixture.id,
    connected: true,
    removed: true,
    assurance: "synthetic documented token protocol; no live instance",
    documentation: fixture.documentation,
  };
}
