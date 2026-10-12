/** Native manually supplied Vault tokens: real provider issue, browser verify/read/removal. */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { requestJson } from "../../../scripts/test/provider-auth-services.mjs";
import { checkNothingInTheClear } from "./lib/at-rest-contract.mjs";
import {
  nativeEnableConnections,
  nativeVisit,
} from "./lib/native-browser-catalog-journey.mjs";
import { sealWithPin, unlockWithPin } from "./lib/pages-journey.mjs";
import { readAuthorizedSecret } from "./provider-auth-evidence.mjs";

async function connectToken(page, { base, provider, service, token }) {
  await nativeVisit(page, base, `connections/${provider.id}`);
  await page
    .getByRole("radio", { name: `${provider.name} token`, exact: true })
    .check();
  await page
    .getByLabel("Instance HTTPS origin", { exact: true })
    .fill(service.endpoint);
  await page.getByLabel("Provider token", { exact: true }).fill(token);
  await page
    .getByRole("button", {
      name: `Verify and connect ${provider.name}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("img", {
      name: `${provider.name} access verified`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Provider token", { exact: true })).toHaveValue(
    "",
  );
}

async function removeToken(page, service, token) {
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm remove connector", exact: true }),
  ).toHaveCount(0);
  const lookup = await requestJson(
    `${service.endpoint}/v1/auth/token/lookup-self`,
    { ca: service.ca, token },
  );
  assert.equal(
    lookup.status,
    200,
    "Local removal does not revoke a user-supplied provider token",
  );
}

export async function proveManualProviderTokens({
  browser,
  services,
  site,
  base,
  device,
  label,
}) {
  const context = await browser.newContext({
    ...device,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${site.origin}${base}`);
    await sealWithPin(page);
    await nativeEnableConnections(page, base);
    for (const provider of [
      { id: "vault", name: "HashiCorp Vault" },
      { id: "openbao", name: "OpenBao" },
    ]) {
      const service = services[provider.id];
      const issued = await service.api("auth/token/create", {
        policies: ["browser-read"],
        ttl: "10m",
        renewable: false,
      });
      const token = issued.auth.client_token;
      assert.ok(Boolean(token), "Actual provider issues a restricted token");
      try {
        await connectToken(page, { base, provider, service, token });
        await readAuthorizedSecret(page);
        const failures = [];
        await checkNothingInTheClear(
          page,
          (ok, detail) => {
            if (!ok) failures.push(detail);
          },
          [token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")],
        );
        assert.equal(
          failures.length,
          0,
          "Manually supplied bearer rests only in ciphertext",
        );
        await page.reload();
        await unlockWithPin(page);
        await nativeEnableConnections(page, base);
        await nativeVisit(page, base, `connections/${provider.id}`);
        await expect(
          page.getByRole("img", {
            name: `${provider.name} access verified`,
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByLabel("Provider token", { exact: true }),
        ).toHaveValue("");
        await readAuthorizedSecret(page);
        await removeToken(page, service, token);
        await page.reload();
        await unlockWithPin(page);
        await nativeEnableConnections(page, base);
        await nativeVisit(page, base, `connections/${provider.id}`);
        await expect(
          page.getByRole("button", { name: "Remove connector", exact: true }),
        ).toHaveCount(0);
      } finally {
        await service.api("auth/token/revoke", { token });
      }
    }
    assert.deepEqual(errors, []);
    return {
      label,
      locallyRunningRealServices: true,
      realProviderIssuedRestrictedTokens: true,
      actualManualTokenKvRead: true,
      sealedColdReload: true,
      tokenInputNeverPrefilled: true,
      localRemovalPreservesUserToken: true,
      removedTokenBindingAbsentAfterReload: true,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}
