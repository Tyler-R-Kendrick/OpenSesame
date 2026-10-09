/** Production UI authorization against real provider services, never success fixtures. */
import "./lib/expect-timeout.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { requestJson } from "../../../scripts/test/provider-auth-services.mjs";
import { checkNothingInTheClear } from "./lib/at-rest-contract.mjs";
import { nativeEnableConnections } from "./lib/native-browser-catalog-journey.mjs";
import { unlockWithPin } from "./lib/pages-journey.mjs";
import { refuseUnsolicitedProviderCallbacks } from "./provider-auth-callback-probes.mjs";
import {
  captureVerifiedProviderMenu,
  readAuthorizedSecret,
} from "./provider-auth-evidence.mjs";
import {
  observeProviderAuth,
  saveProviderFailure,
  validateIssuedProviderGrants,
} from "./provider-auth-observations.mjs";
import {
  finishProvider,
  openProvider,
  prepareProviderOriginators,
} from "./provider-auth-originators.mjs";

async function completeProviderOriginators({
  page,
  secondary,
  leftPopup,
  rightPopup,
  idp,
  exchanges,
  grants,
  settleResponses,
  site,
}) {
  // Complete in reverse order: each static return must reach its own tab.
  await finishProvider(rightPopup, idp);
  await secondary
    .getByRole("img", { name: "OpenBao connected", exact: true })
    .waitFor();
  assert.equal(exchanges.length, 1);
  assert.equal(
    await page
      .getByRole("img", { name: "HashiCorp Vault connected", exact: true })
      .count(),
    0,
    "Other tab cannot consume this authorization",
  );
  await finishProvider(leftPopup, idp);
  await page
    .getByRole("img", { name: "HashiCorp Vault connected", exact: true })
    .waitFor();
  await settleResponses();
  await expect.poll(() => grants.length).toBe(2);
  for (const originator of [page, secondary]) {
    assert.equal(
      await originator.evaluate(() => crossOriginIsolated),
      true,
      "The initiating vault remains cross-origin isolated",
    );
    assert.equal(
      new URL(originator.url()).searchParams.has("code"),
      false,
      "The authorization code never enters the original app URL",
    );
    assert.equal(
      new URL(originator.url()).searchParams.has("state"),
      false,
      "The static callback does not reroute the original vault",
    );
  }
  assert.ok(
    grants[0] !== grants[1],
    "The two provider connections own separate real tokens",
  );
  assert.equal(site.observations.returns.length >= 3, true);
}
async function proveSealedProviderAndReplay({
  page,
  context,
  out,
  grants,
  callbacks,
  exchanges,
  label,
}) {
  await readAuthorizedSecret(page);
  await page.bringToFront();
  await page.screenshot({
    path: `${out}/${label}-vault-real-oidc-connected.png`,
    fullPage: false,
    animations: "disabled",
  });
  const checks = [];
  await checkNothingInTheClear(
    page,
    (ok, detail) => {
      checks.push({ ok, detail });
    },
    grants.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.deepEqual(
    checks.filter((check) => !check.ok),
    [],
    "Actual issued tokens never rest in plaintext",
  );

  const replay = await context.newPage();
  const exchangeCount = exchanges.length;
  await replay.goto(callbacks.at(-1));
  await expect.poll(() => new URL(replay.url()).search).toBe("");
  await expect(
    replay.getByText("Sign-in expired. Close this window and try again.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 10000 });
  assert.equal(
    exchanges.length,
    exchangeCount,
    "Completed callback cannot replay another code exchange",
  );
  await replay.close();
}
async function reloadAndRemoveProviders({
  page,
  secondary,
  providers,
  base,
  grantServices,
  grants,
}) {
  await secondary.close();
  // Fresh document loses every in-memory grant and must unlock sealed state.
  await page.reload();
  await unlockWithPin(page);
  await nativeEnableConnections(page, base);
  for (const provider of providers) {
    await openProvider(page, base, provider);
    await page
      .getByRole("button", { name: "Remove connector", exact: true })
      .waitFor();
    await readAuthorizedSecret(page);
    await page
      .getByRole("button", { name: "Remove connector", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm remove connector", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Confirm remove connector",
        exact: true,
      }),
    ).toHaveCount(0);
  }
  for (const token of grants) {
    const bao = grantServices.get(token);
    assert.ok(
      bao,
      "An issued token must belong to its actual provider service",
    );
    const revoked = await requestJson(
      `${bao.endpoint}/v1/auth/token/lookup-self`,
      { ca: bao.ca, token },
    );
    assert.equal(
      revoked.status,
      403,
      "Removing a connector revokes its actual OIDC-issued provider token",
    );
  }
  await page.reload();
  await unlockWithPin(page);
  await nativeEnableConnections(page, base);
  for (const provider of providers) {
    await openProvider(page, base, provider);
    assert.equal(
      await page
        .getByRole("button", { name: "Remove connector", exact: true })
        .count(),
      0,
      "Removed connection remains absent after cold reload",
    );
  }
}
export async function providerAuthBrowserJourney(input) {
  const { browser, services, idp, site, base, out, label, device } = input;
  const context = await browser.newContext({
    ...device,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const observed = observeProviderAuth(context, { services, idp, site });
  const page = await context.newPage();
  const providers = [
    { id: "vault", name: "HashiCorp Vault" },
    { id: "openbao", name: "OpenBao" },
  ];
  let step = "start-originators";
  try {
    const originators = await prepareProviderOriginators({
      page,
      context,
      site,
      base,
      services,
      providers,
      idp,
      exchanges: observed.exchanges,
      out,
      label,
    });
    step = "refuse-unsolicited-callbacks";
    await refuseUnsolicitedProviderCallbacks({
      context,
      page,
      idp,
      site,
      base,
      ...observed,
    });
    step = "complete-provider-authentication";
    await completeProviderOriginators({
      page,
      idp,
      site,
      ...originators,
      ...observed,
    });
    step = "authorized-read-sealed-storage-and-replay";
    await validateIssuedProviderGrants(observed);
    await proveSealedProviderAndReplay({
      page,
      context,
      out,
      label,
      ...observed,
    });
    step = "cold-reload-and-provider-revocation";
    await captureVerifiedProviderMenu({ page, base, out, label });
    await reloadAndRemoveProviders({
      page,
      providers,
      base,
      ...originators,
      ...observed,
    });
    const { errors } = observed;
    assert.deepEqual(
      errors,
      [],
      "No browser script errors during real authentication",
    );
    return {
      label,
      productionUi: true,
      locallyRunningRealServices: true,
      fabricatedProviderResponses: 0,
      concurrentOriginators: 2,
      strictCoop: true,
      providerOpenerNull: true,
      userCancellationBeforeConsent: true,
      lockedOwnerCannotActivate: true,
      wrongStateNoExchange: true,
      wrongSourceNoExchange: true,
      replayNoExchange: true,
      actualKvRead: true,
      sealedColdReload: true,
      actualIssuedGrantRevokedOnRemoval: true,
      browserErrors: errors.length,
    };
  } catch (error) {
    await saveProviderFailure({ page, out, label, step, error, observed });
    throw error;
  } finally {
    try {
      await observed.settleResponses();
    } finally {
      await context.close();
    }
  }
}
