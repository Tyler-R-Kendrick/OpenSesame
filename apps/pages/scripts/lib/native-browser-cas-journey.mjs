import { expect } from "@playwright/test";
/** Concurrent human edits must preserve the public configuration/private credential pair. */
import { fillNativeApiFixture } from "./native-browser-api-journey.mjs";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import { unlockWithPin } from "./pages-journey.mjs";

async function nativeRevisionRefusal(page, secondary, check) {
  const refusal = /Connector changed; reload|connection changed; reload/;
  const attempts = await Promise.all([
    page.getByRole("img", { name: refusal }).count(),
    secondary.getByRole("img", { name: refusal }).count(),
  ]);
  check(
    attempts.some((count) => count > 0),
    "competing edit reports the actual stale revision refusal before retry",
  );
}

async function editAppearance(page, name) {
  await page
    .locator("summary")
    .filter({ hasText: /^Appearance$/ })
    .click();
  await page.getByLabel("Connector name", { exact: true }).fill(name);
}
async function appearanceName(page) {
  await page
    .locator("summary")
    .filter({ hasText: /^Appearance$/ })
    .click();
  return page.getByLabel("Connector name", { exact: true }).inputValue();
}

export async function nativeCasJourney(
  page,
  context,
  harness,
  authority,
  fixture,
  { base, observe },
) {
  harness.setStep("native-cross-tab-configuration-binding");
  await nativeVisit(page, base, `connections/${fixture.providerId}`);
  await page
    .getByRole("heading", { name: fixture.name, exact: true })
    .waitFor();
  const submitLabel = `Verify and connect ${fixture.name}`;
  if (
    !(await page
      .getByRole("button", { name: submitLabel, exact: true })
      .count())
  )
    return;
  const secondary = await context.newPage();
  observe(secondary);
  authority.state.expectedDocuments.add(page.url());
  await secondary.goto(page.url());
  await unlockWithPin(secondary);
  const first = authority.alternate(fixture, "tab-a");
  const second = authority.alternate(fixture, "tab-b");
  await editAppearance(page, "Protocol connection tab-a");
  await editAppearance(secondary, "Protocol connection tab-b");
  await fillNativeApiFixture(page, first);
  await fillNativeApiFixture(secondary, second);
  const release = authority.pause(fixture.providerId);
  try {
    await page.getByRole("button", { name: submitLabel, exact: true }).click();
    await secondary
      .getByRole("button", { name: submitLabel, exact: true })
      .click();
    await page.waitForTimeout(200);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: submitLabel, exact: true }),
  ).not.toHaveAttribute("aria-busy", "true");
  await expect(
    secondary.getByRole("button", { name: submitLabel, exact: true }),
  ).not.toHaveAttribute("aria-busy", "true");
  await nativeRevisionRefusal(page, secondary, harness.check);
  await secondary.close();
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  const name = await appearanceName(page);
  harness.check(
    ["Protocol connection tab-a", "Protocol connection tab-b"].includes(name),
    "cross-tab edit retains one complete human configuration",
  );
  const before = authority.state.calls.length;
  const verify = page.getByRole("button", {
    name: `Verify ${fixture.name} access`,
    exact: true,
  });
  await verify.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(verify).toBeEnabled();
  const calls = authority.state.calls
    .slice(before)
    .filter((call) => call.providerId === fixture.providerId);
  harness.check(
    calls.length === 1,
    "cold verification reads exactly one durable provider credential",
  );
  harness.check(
    calls[0]?.credentialProof === name.replace("Protocol connection ", ""),
    "public name and sealed credential remain atomically bound across competing edits",
  );
}
