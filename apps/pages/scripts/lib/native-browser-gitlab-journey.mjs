/** Actual GitLab public client controls and sealed callback/account read. */
import { expect } from "@playwright/test";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import {
  approveNativePublicConsent,
  nativeProtocolGeometry,
  noNativeSecrets,
} from "./native-browser-public-journey.mjs";
import { unlockWithPin } from "./pages-journey.mjs";

export async function nativeGitlabJourney(
  page,
  harness,
  authority,
  { base, out, label, callback },
) {
  harness.setStep(`${label}-gitlab-public`);
  await nativeVisit(page, base, "connections/gitlab");
  await page.getByRole("heading", { name: "GitLab", exact: true }).waitFor();
  const oauthMethod = page.getByRole("radio", {
    name: "Bring Your Own OAuth App",
    exact: true,
  });
  if (await oauthMethod.count()) await oauthMethod.check();
  await page
    .getByLabel("GitLab public client ID", { exact: true })
    .fill("protocol-public-gitlab-client");
  const mark = page.getByRole("img", { name: "GitLab connected", exact: true });
  harness.check(
    (await mark.count()) === 0,
    "unsubmitted public REST configuration alone never becomes connected",
  );
  await approveNativePublicConsent(
    page,
    callback,
    page.getByRole("button", {
      name: "Sign in to GitLab",
      exact: true,
    }),
  );
  await mark.waitFor({ timeout: 30_000 });
  await page
    .getByText("Disclosed GitLab protocol account", { exact: true })
    .first()
    .waitFor();
  await noNativeSecrets(page, authority.secrets, harness.check);
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await mark.waitFor();
  await page
    .locator("summary")
    .filter({ hasText: "Check GitLab access" })
    .click();
  const before = authority.state.calls.filter(
    (call) => call.path === "/api/v4/user",
  ).length;
  await page
    .getByRole("button", { name: "Check GitLab access", exact: true })
    .click();
  await expect
    .poll(
      () =>
        authority.state.calls.filter((call) => call.path === "/api/v4/user")
          .length,
    )
    .toBe(before + 1);
  harness.check(
    true,
    "cold-reloaded GitLab action performs an actual provider account read",
  );
  await page
    .getByRole("region", { name: "GitLab connection status", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${out}/${label}-gitlab-account-result.png`,
    fullPage: false,
    animations: "disabled",
  });
  const geometry = await nativeProtocolGeometry(page);
  harness.check(
    geometry.documentWidth <= geometry.viewportWidth,
    "verified GitLab account result fits the physical viewport without horizontal overflow",
  );
  await noNativeSecrets(page, authority.secrets, harness.check);
  await removeGitlabProtocolConnection(page, authority);
  return {
    label,
    providerId: "gitlab",
    geometry,
    protocolCalls: authority.state.calls,
    assurance:
      "production UI against disclosed HTTP protocol authority; no live account",
  };
}

async function removeGitlabProtocolConnection(page, authority) {
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await expect
    .poll(
      () =>
        authority.state.calls.filter((call) => call.path === "/oauth/revoke")
          .length,
    )
    .toBe(2);
}
