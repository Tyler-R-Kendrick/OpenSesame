/** Actual wrong-state returns and cross-origin message sources cannot select a vault session. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { expect } from "@playwright/test";

export async function cancelProviderConsent({
  page,
  popup,
  provider,
  approve,
  exchanges,
}) {
  await page
    .getByRole("button", { name: "Cancel sign-in", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Sign in to ${provider.name}`,
      exact: true,
    }),
  ).toBeEnabled();
  assert.equal(
    await page
      .getByRole("img", { name: `${provider.name} connected`, exact: true })
      .count(),
    0,
    "Cancel before provider approval cannot install a connector",
  );
  // COOP may remove the original tab's ability to close the provider window.
  // Genuine late provider approval must still be rejected by the canceled owner.
  await refuseLateProviderApproval({ popup, approve, exchanges });
}

export async function refuseLateProviderApproval({
  popup,
  approve,
  exchanges,
}) {
  await approve();
  await expect.poll(() => new URL(popup.url()).search).toBe("");
  await expect(
    popup.getByText("Sign-in expired. Close this window and try again.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 10000 });
  assert.equal(
    exchanges.length,
    0,
    "Approval after the owner closes cannot issue a provider token",
  );
  await popup.close();
}

async function proveUntrustedProviderMessage(context, src) {
  const attacker = await context.newPage();
  await attacker.goto(src);
  // The issuer really broadcasts the valid envelope on the exact state channel.
  // BroadcastChannel's origin boundary, rather than an unexercised listener,
  // prevents that foreign-origin source from reaching the initiating app.
  await expect(attacker.locator("body")).toHaveAttribute("data-sent", "true");
  await attacker.waitForTimeout(300);
  await attacker.close();
}

export async function refuseUnsolicitedProviderCallbacks({
  context,
  idp,
  site,
  base,
  exchanges,
  providerStates,
}) {
  // An unsolicited callback on the same static endpoint has no active state
  // channel and must neither select a connection nor issue a provider request.
  const wrong = await context.newPage();
  const wrongState = randomBytes(32).toString("hex");
  await wrong.goto(
    `${site.origin}${base}auth/native-connector.html?state=${wrongState}&code=unrequested-code`,
  );
  await expect.poll(() => new URL(wrong.url()).search).toBe("");
  assert.equal(exchanges.length, 0, "Wrong state never exchanges a code");
  await expect(
    wrong.getByText("Sign-in expired. Close this window and try again.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 10000 });
  assert.equal(
    exchanges.length,
    0,
    "Unsolicited callback cannot exchange after its delivery deadline",
  );
  await wrong.close();
  const activeState = providerStates.at(-1);
  assert.ok(
    activeState,
    "Observe the actual pending provider authorization state",
  );
  await proveUntrustedProviderMessage(
    context,
    `${idp.issuer}/untrusted-message?state=${encodeURIComponent(activeState)}`,
  );
  assert.equal(
    exchanges.length,
    0,
    "Untrusted provider web message cannot select the original tab",
  );
}
