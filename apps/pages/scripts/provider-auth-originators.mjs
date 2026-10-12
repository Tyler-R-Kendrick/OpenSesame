/** Real provider browser ceremonies, cancellation and initiating vault isolation. */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  nativeEnableConnections,
  nativeVisit,
} from "./lib/native-browser-catalog-journey.mjs";
import { lockVault, sealWithPin, unlockWithPin } from "./lib/pages-journey.mjs";
import {
  cancelProviderConsent,
  refuseLateProviderApproval,
} from "./provider-auth-callback-probes.mjs";

export async function openProvider(page, base, provider) {
  await nativeVisit(page, base, `connections/${provider.id}`);
  await page
    .getByRole("heading", { name: provider.name, exact: true })
    .waitFor();
}

async function beginProvider(page, { base, provider, bao }) {
  await openProvider(page, base, provider);
  await page
    .getByLabel("Instance HTTPS origin", { exact: true })
    .fill(bao.endpoint);
  const popupPromise = page.context().waitForEvent("page");
  await page
    .getByRole("button", { name: `Sign in to ${provider.name}`, exact: true })
    .click();
  const popup = await popupPromise;
  await popup
    .getByRole("heading", { name: "Provider sign in", exact: true })
    .waitFor()
    .catch(async (error) => {
      await expect(
        page.getByRole("button", {
          name: `Sign in to ${provider.name}`,
          exact: true,
        }),
      ).toBeEnabled();
      throw new Error(
        `Provider window closed before consent: ${await page.getByRole("img").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")).join("; "))}`,
        { cause: error },
      );
    });
  assert.equal(
    await popup.evaluate(() => window.opener === null),
    true,
    "Provider receives no opener capability under strict COOP",
  );
  await expect(
    page.getByRole("button", { name: "Cancel sign-in", exact: true }),
  ).toBeEnabled();
  return popup;
}

export async function finishProvider(popup, idp) {
  await popup.getByLabel("Username", { exact: true }).fill("provider-user");
  await popup.getByLabel("Password", { exact: true }).fill(idp.password);
  await popup
    .getByRole("button", { name: "Sign in to provider", exact: true })
    .click();
}

export async function prepareProviderOriginators({
  page,
  context,
  site,
  base,
  services,
  providers,
  idp,
  exchanges,
  out,
  label,
}) {
  await page.goto(`${site.origin}${base}`);
  await sealWithPin(page);
  await nativeEnableConnections(page, base);
  const secondary = await context.newPage();
  await secondary.goto(`${site.origin}${base}`);
  await unlockWithPin(secondary);
  await nativeEnableConnections(secondary, base);
  const canceled = await beginProvider(page, {
    base,
    provider: providers[0],
    bao: services.vault,
  });
  await page.bringToFront();
  await page.screenshot({
    path: `${out}/${label}-vault-real-oidc-signing-in.png`,
    fullPage: false,
    animations: "disabled",
  });
  await cancelProviderConsent({
    page,
    popup: canceled,
    provider: providers[0],
    approve: () => finishProvider(canceled, idp),
    exchanges,
  });
  // Start the concurrent ceremony with fresh issuer login sessions. A prior
  // real login can otherwise return silently before a second user interaction.
  await context.clearCookies({ domain: new URL(idp.issuer).hostname });
  const lockedPopup = await beginProvider(page, {
    base,
    provider: providers[0],
    bao: services.vault,
  });
  await lockVault(page);
  await refuseLateProviderApproval({
    popup: lockedPopup,
    approve: () => finishProvider(lockedPopup, idp),
    exchanges,
  });
  await unlockWithPin(page);
  await nativeEnableConnections(page, base);
  await context.clearCookies({ domain: new URL(idp.issuer).hostname });
  const leftPopup = await beginProvider(page, {
    base,
    provider: providers[0],
    bao: services.vault,
  });
  const rightPopup = await beginProvider(secondary, {
    base,
    provider: providers[1],
    bao: services.openbao,
  });

  return { secondary, leftPopup, rightPopup };
}
