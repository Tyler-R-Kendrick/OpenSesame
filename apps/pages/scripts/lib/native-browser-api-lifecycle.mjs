/** Human read and local removal after encrypted reload, against the fixed HTTP authority. */
import { expect } from "@playwright/test";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import { unlockWithPin } from "./pages-journey.mjs";

export async function nativeVerifiedCapture(page, path) {
  await page
    .locator("#complete h2")
    .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
  await page.locator("#complete").hover({ position: { x: 30, y: 30 } });
  await page.mouse.wheel(0, -100);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
}

export async function nativeApiReadJourney(page, harness, authority, fixture) {
  const label = `Check ${fixture.name} access`;
  const summary = page.locator("summary").filter({ hasText: label });
  await summary.click();
  const action = page.getByRole("button", { name: label, exact: true });
  const before = authority.state.calls.length;
  await action.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(action).not.toHaveAttribute("aria-busy", "true");
  const output = page.locator("main output");
  await output.waitFor();
  const text = await output.innerText();
  harness.check(
    authority.state.calls.length === before + 1,
    `${fixture.providerId}: Check access reads the sealed credential through one actual provider request`,
  );
  harness.check(
    text.trim().length > 0 && !/: none found/.test(text),
    `${fixture.providerId}: the action returns actual verification prose without inventing an empty resource list`,
  );
  for (const value of Object.values(fixture.credentials))
    harness.check(
      !text.includes(value),
      `${fixture.providerId}: read results do not expose private credential values`,
    );
}

export async function nativeApiForgetJourney(
  page,
  harness,
  authority,
  fixture,
  { base, label },
) {
  harness.setStep(`${label}-api-local-forget-${fixture.providerId}`);
  await nativeVisit(page, base, `connections/${fixture.providerId}`);
  await page
    .getByRole("heading", { name: fixture.name, exact: true })
    .waitFor();
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
  await expect(
    page.getByRole("button", { name: "Remove connector", exact: true }),
  ).toHaveCount(0);
  harness.check(
    authority.state.calls.length === before,
    `${fixture.providerId}: local removal performs no provider-wide key revocation`,
  );
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await page
    .getByRole("heading", { name: fixture.name, exact: true })
    .waitFor();
  await expect(
    page.getByRole("button", { name: "Remove connector", exact: true }),
  ).toHaveCount(0);
  harness.check(
    true,
    `${fixture.providerId}: removed connection stays absent after encrypted cold reload`,
  );
  const passwords = page.locator('main input[type="password"]');
  harness.check(
    await passwords.evaluateAll((inputs) =>
      inputs.every((input) => input.value === ""),
    ),
    `${fixture.providerId}: removal does not reveal the previously sealed credential`,
  );
  return {
    providerId: fixture.providerId,
    label,
    localForgetAfterReload: true,
  };
}
