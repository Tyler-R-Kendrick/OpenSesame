import { expect } from "@playwright/test";
import { nativeApiGuideJourney } from "./native-browser-api-guide.mjs";
import {
  nativeApiReadJourney,
  nativeVerifiedCapture,
} from "./native-browser-api-lifecycle.mjs";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
/** Human controls against real compiled HTTP handlers, with encrypted cold reload. */
import { unlockWithPin } from "./pages-journey.mjs";

function nativeKeyLabel(fixture) {
  return `${fixture.name} ${fixture.variant?.label ?? "API key"}`;
}

export async function fillNativeApiFixture(page, fixture) {
  const options = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: /^Sign-in options$/ }),
  });
  if ((await options.count()) && (await options.getAttribute("open")) === null)
    await options
      .locator("summary")
      .filter({ hasText: /^Sign-in options$/ })
      .click();
  const variant = page.getByLabel("Credential type", { exact: true });
  if (fixture.variant && (await variant.count()))
    await variant.selectOption(fixture.variant.id);
  for (const field of fixture.preset.templateParams) {
    const input = page.getByLabel(field.label, {
      exact: true,
      selector: field.secret ? 'input[type="password"]' : "input, select",
    });
    const value = (field.secret ? fixture.credentials : fixture.parameters)[
      field.name
    ];
    if (field.choices) await input.selectOption(value);
    else await input.fill(value);
  }
  for (const field of fixture.preset.additionalCredentials)
    await page
      .getByLabel(field.label, {
        exact: true,
        selector: 'input[type="password"]',
      })
      .fill(fixture.credentials[field.name]);
  await page
    .getByLabel(nativeKeyLabel(fixture), {
      exact: true,
      selector: 'input[type="password"]',
    })
    .fill(fixture.credentials.api_key);
}

function verifiedMark(page, fixture) {
  return page.getByRole("img", {
    name: new RegExp(
      `^${fixture.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (connected|access verified)$`,
    ),
  });
}

async function noSecretRendered(page, fixture, check) {
  const text = await page.locator("body").innerText();
  for (const value of Object.values(fixture.credentials))
    check(
      !text.includes(value),
      `${fixture.providerId}: human credentials never appear in rendered prose`,
    );
}

async function nativeApiAvailability(page, harness, fixture, submit) {
  const radio = page.getByRole("radio", { name: "API Key", exact: true });
  if ((await radio.count()) && (await radio.isEnabled())) await radio.check();
  if (!(await submit.count())) {
    const signIn = page.getByRole("button", {
      name: `Sign in to ${fixture.name}`,
      exact: true,
    });
    if (await signIn.count()) {
      harness.check(
        (await page
          .getByLabel(nativeKeyLabel(fixture), {
            exact: true,
            selector: 'input[type="password"]',
          })
          .count()) === 0,
        `${fixture.providerId}: primary approved sign-in route does not collect unsupported API credentials`,
      );
      return "alternative public browser sign-in route";
    }
    harness.check(
      (await page
        .getByRole("img", {
          name: `${fixture.name} has no supported browser connection method.`,
          exact: true,
        })
        .count()) > 0,
      `${fixture.providerId}: unavailable browser route indicates desktop capability`,
    );
    harness.check(
      (await page.locator('main input[type="password"]').count()) === 0,
      `${fixture.providerId}: unavailable route does not collect private credentials`,
    );
    return "outside-browser capability";
  }
  const variant = page.getByLabel("Credential type", { exact: true });
  if (fixture.variant && (await variant.count()))
    await variant.selectOption(fixture.variant.id);
  if (
    !(await page
      .getByLabel(nativeKeyLabel(fixture), {
        exact: true,
        selector: 'input[type="password"]',
      })
      .count())
  ) {
    harness.check(
      ((await radio.count()) > 0 && (await radio.isDisabled())) ||
        (await submit.isDisabled()),
      `${fixture.providerId}: unavailable API route cannot submit credentials; alternate browser method preserved`,
    );
    return "alternative browser route";
  }
  return null;
}

export async function nativeApiJourney(
  page,
  harness,
  authority,
  fixture,
  { base, out, label },
) {
  harness.setStep(`${label}-api-${fixture.providerId}`);
  await nativeVisit(page, base, `connections/${fixture.providerId}`);
  await page
    .getByRole("heading", { name: fixture.name, exact: true })
    .waitFor();
  const submit = page.getByRole("button", {
    name: `Verify and connect ${fixture.name}`,
    exact: true,
  });
  const reason = await nativeApiAvailability(page, harness, fixture, submit);
  if (reason)
    return { providerId: fixture.providerId, connected: false, reason };
  await nativeApiGuideJourney(page, harness, fixture);
  await page.screenshot({
    path: `${out}/${label}-${fixture.providerId}-configure.png`,
    fullPage: false,
  });
  authority.state.reject.add(fixture.providerId);
  await fillNativeApiFixture(page, fixture);
  const before = authority.state.calls.length;
  await submit.click();
  await expect.poll(() => authority.state.calls.length).toBeGreaterThan(before);
  await expect(submit).toBeEnabled();
  harness.check(
    (await verifiedMark(page, fixture).count()) === 0,
    `${fixture.providerId}: rejected real credential never becomes connected`,
  );
  await noSecretRendered(page, fixture, harness.check);
  authority.state.reject.delete(fixture.providerId);
  await submit.click();
  await verifiedMark(page, fixture).waitFor({ timeout: 20_000 });
  harness.check(
    authority.state.calls.some(
      (call) => call.providerId === fixture.providerId,
    ),
    `${fixture.providerId}: provider verification really crossed the fixed HTTP boundary`,
  );
  harness.check(
    (await page
      .getByLabel(nativeKeyLabel(fixture), {
        exact: true,
        selector: 'input[type="password"]',
      })
      .inputValue()) === "",
    `${fixture.providerId}: verified save clears entered key`,
  );
  await noSecretRendered(page, fixture, harness.check);
  await nativeVerifiedCapture(
    page,
    `${out}/${label}-${fixture.providerId}-verified.png`,
  );
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await verifiedMark(page, fixture).waitFor({ timeout: 20_000 });
  await noSecretRendered(page, fixture, harness.check);
  harness.check(
    true,
    `${fixture.providerId}: verified identity and authorization survive encrypted cold reload`,
  );
  await nativeApiReadJourney(page, harness, authority, fixture);
  return {
    providerId: fixture.providerId,
    connected: true,
    readAfterReload: true,
    assurance: "synthetic protocol authority; no live account",
  };
}
