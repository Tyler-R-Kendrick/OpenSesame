/** Genuine provider policy changes must not turn permission denial into revocation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { requestJson } from "../../../../scripts/test/provider-auth-services.mjs";
import { finishProvider, openProvider } from "../provider-auth-originators.mjs";
import { nativeEnableConnections } from "./native-browser-catalog-journey.mjs";
import { unlockWithPin } from "./pages-journey.mjs";

const policy = 'path "secret/data/browser-auth" { capabilities = ["read"] }';
const deniedPolicy = `${policy}
path "auth/token/revoke-self" { capabilities = ["deny"] }
path "auth/token/lookup-self" { capabilities = ["deny"] }`;

async function remove(page) {
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
}

async function assertDeniedOperations(service, token) {
  for (const [route, method] of [
    ["lookup-self", "GET"],
    ["revoke-self", "POST"],
  ]) {
    const denied = await requestJson(
      `${service.endpoint}/v1/auth/token/${route}`,
      {
        ca: service.ca,
        token,
        method,
      },
    );
    assert.equal(
      denied.status,
      403,
      "The actual provider must deny token-owned policy operations",
    );
  }
}

async function captureDeniedCleanup({
  page,
  service,
  provider,
  token,
  out,
  label,
}) {
  await expect(
    page.getByRole("button", {
      name: "Confirm remove connector",
      exact: true,
    }),
  ).toHaveCount(0);
  const valid = await service.api("auth/token/lookup", { token });
  assert.ok(
    valid.data.entity_id,
    "Independent root lookup proves the denied token remains valid",
  );
  const recovery = page.getByRole("region", {
    name: "Provider recovery",
    exact: true,
  });
  const recoveryCount = await recovery.count();
  if (recoveryCount) await recovery.scrollIntoViewIfNeeded();
  await page.bringToFront();
  const stem = path.join(out, `${label}-${provider.id}-cleanup-denied`);
  await page.screenshot({
    path: `${stem}.png`,
    fullPage: false,
    animations: "disabled",
  });
  fs.writeFileSync(
    `${stem}.json`,
    `${JSON.stringify(
      {
        provider: service.name,
        independentRootLookupConfirmsValidToken: true,
        providerRecoveryRegions: recoveryCount,
        removeActions: await page
          .getByRole("button", { name: "Remove connector", exact: true })
          .count(),
        body: await page.locator("body").innerText(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function confirmActualRevocation(page, service, token) {
  const request = page.waitForRequest(
    (request) =>
      request.url() === `${service.endpoint}/v1/auth/token/revoke-self` &&
      request.headers()["x-vault-token"] === token,
  );
  await remove(page);
  await request;
  await expect(
    page.getByRole("button", { name: "Confirm remove connector", exact: true }),
  ).toHaveCount(0);
  const root = await service.api("auth/token/lookup-self");
  assert.ok(
    root.data.policies.includes("root"),
    "The independent verifier must retain root authorization",
  );
  await assert.rejects(
    () => service.api("auth/token/lookup", { token }),
    /HTTP 403/,
    "Independent root lookup must reject the actually revoked token",
  );
}

export async function proveDeniedProviderCleanup(input) {
  const { page, service, provider, token, base } = input;
  const root = await service.api("auth/token/lookup-self");
  assert.ok(
    root.data.policies.includes("root"),
    "The independent verifier must start with root authorization",
  );
  await service.api("sys/policies/acl/browser-read", { policy: deniedPolicy });
  try {
    await assertDeniedOperations(service, token);
    await remove(page);
    await captureDeniedCleanup(input);
    const recovery = () =>
      page.getByRole("region", { name: "Provider recovery", exact: true });
    await expect(recovery()).toBeVisible();
    await page.reload();
    await unlockWithPin(page);
    await nativeEnableConnections(page, base);
    await openProvider(page, base, provider);
    await expect(recovery()).toBeVisible();
  } finally {
    await service.api("sys/policies/acl/browser-read", { policy });
  }
  await confirmActualRevocation(page, service, token);
  return {
    service: service.name,
    providerPolicyChanged: true,
    doublePermissionDenial: true,
    independentRootLookupConfirmsValidToken: true,
    recoverySurvivesColdReload: true,
    actualRetainedTokenUsedForRevocation: true,
    independentRootLookupConfirmsRevokedToken: true,
  };
}

async function signInAgain({ page, provider, service, idp, grants }) {
  await page.context().clearCookies({ domain: new URL(idp.issuer).hostname });
  await page
    .getByLabel("Instance HTTPS origin", { exact: true })
    .fill(service.endpoint);
  const issuedBefore = grants.length;
  const opened = page.context().waitForEvent("page");
  await page
    .getByRole("button", { name: `Sign in to ${provider.name}`, exact: true })
    .click();
  const popup = await opened;
  await popup
    .getByRole("heading", { name: "Provider sign in", exact: true })
    .waitFor();
  await finishProvider(popup, idp);
  await expect(
    page.getByRole("img", { name: `${provider.name} connected`, exact: true }),
  ).toBeVisible();
  await expect.poll(() => grants.length).toBe(issuedBefore + 1);
  return grants[issuedBefore];
}

async function confirmAdministratorRevocation(page, service, token) {
  const prior = await service.api("auth/token/lookup", { token });
  assert.ok(
    prior.data.entity_id,
    "Administrator starts from a genuine valid OIDC token",
  );
  await service.api("auth/token/revoke", { token });
  const root = await service.api("auth/token/lookup-self");
  assert.ok(root.data.policies.includes("root"));
  await assert.rejects(
    () => service.api("auth/token/lookup", { token }),
    /HTTP 403/,
  );
  await remove(page);
  await expect(
    page.getByRole("region", { name: "Provider recovery", exact: true }),
  ).toBeVisible();
}

async function acknowledgeLocalRecovery(page, service, provider) {
  const mutations = [];
  const observe = (request) => {
    if (new URL(request.url()).origin === service.endpoint)
      mutations.push(request);
  };
  page.on("request", observe);
  try {
    const confirm = page.getByRole("button", {
      name: "Confirm provider revocation",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "An administrator revoked this connection token or confirmed it is expired",
        exact: true,
      })
      .check();
    await confirm.click();
    await expect(
      page.getByRole("region", { name: "Provider recovery", exact: true }),
    ).toHaveCount(0);
    assert.equal(
      await page.getByRole("img", { name: / connected$/ }).count(),
      0,
      "Human attestation never reports a verified connection",
    );
    await remove(page);
    await expect(
      page.getByRole("button", {
        name: "Confirm remove connector",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", {
        name: `${provider.name} connection status`,
        exact: true,
      }),
    ).toHaveCount(0);
    assert.equal(
      mutations.length,
      0,
      "Administrator confirmation only forgets local authority",
    );
  } finally {
    page.off("request", observe);
  }
}

export async function proveAlreadyRevokedProviderCleanup(input) {
  const { page, service, provider, out, label } = input;
  const token = await signInAgain(input);
  await confirmAdministratorRevocation(page, service, token);
  const recovery = page.getByRole("region", {
    name: "Provider recovery",
    exact: true,
  });
  await recovery.scrollIntoViewIfNeeded();
  await page.bringToFront();
  await page.screenshot({
    path: path.join(out, `${label}-${provider.id}-admin-revoked.png`),
    fullPage: false,
    animations: "disabled",
  });
  await acknowledgeLocalRecovery(page, service, provider);
  return {
    service: service.name,
    actualAdministratorRevokedToken: true,
    independentRootLookupConfirmsRevokedToken: true,
    ambiguousTokenOwnedDenialRetainsRecovery: true,
    explicitHumanConfirmationClearsOnlyLocalAuthority: true,
    attestationDoesNotVerifyConnection: true,
    removedWithoutProviderMutation: true,
  };
}
