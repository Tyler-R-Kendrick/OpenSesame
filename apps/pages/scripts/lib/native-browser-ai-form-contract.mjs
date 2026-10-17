/** Configuration coverage only: no credentials, inference or provider auth. */
import { TOUCH_FLOOR } from "./mobile-contract.mjs";

async function sharedAiLayout(page, form) {
  const read = () =>
    form.evaluate((node) => {
      const scope = node.closest('[role="dialog"]') ?? node;
      return {
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        right: scope.getBoundingClientRect().right,
        controls: [...scope.querySelectorAll("input, select, button")]
          .filter((control) => control.getClientRects().length > 0)
          .map((control) => ({
            name: control.getAttribute("aria-label") ?? control.tagName,
            height: control.getBoundingClientRect().height,
          })),
      };
    });
  let previous = JSON.stringify(await read());
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(100);
    const next = await read();
    if (JSON.stringify(next) === previous) return next;
    previous = JSON.stringify(next);
  }
  return read();
}

async function sharedAiDefaults(form, row, preset, check) {
  const fields = {};
  for (const [label, expected] of [
    ["Connection name", preset.name],
    ["API family", preset.family],
    ["API base URL", preset.baseUrl],
    ["Model ID", ""],
    ["Authentication", "api-key"],
    ["API key", ""],
  ]) {
    const field = form.getByLabel(label, { exact: true });
    const value = await field.inputValue();
    check(
      value === expected,
      `${row.id}: ${label} has its public provider default`,
    );
    const configurable = ["API family", "Authentication"].includes(label)
      ? await field.isEnabled()
      : await field.isEditable();
    check(configurable, `${row.id}: ${label} is configurable`);
    fields[label] =
      label === "API key"
        ? { blank: value === "", configurable }
        : { value, configurable };
  }
  const families = await form
    .getByLabel("API family", { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  check(
    JSON.stringify(families) === JSON.stringify(preset.families),
    `${row.id}: supported inference API families are explicit`,
  );
  const authentication = await form
    .getByLabel("Authentication", { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  check(
    JSON.stringify(authentication) === JSON.stringify(["api-key", "none"]),
    `${row.id}: API key and unauthenticated endpoints are selectable`,
  );
  const apiKeyType = await form
    .getByLabel("API key", { exact: true })
    .getAttribute("type");
  check(
    apiKeyType === "password",
    `${row.id}: the blank API key is write-only`,
  );
  const actionsDisabled = {};
  for (const name of ["Test AI connection", "Save AI connection"]) {
    const disabled = await form
      .getByRole("button", { name, exact: true })
      .isDisabled();
    check(disabled, `${row.id}: ${name} requires a complete configuration`);
    actionsDisabled[name] = disabled;
  }
  return { fields, families, authentication, apiKeyType, actionsDisabled };
}

export async function nativeAiFormContract(
  page,
  row,
  preset,
  { check, record, phone, sheet, routePath, base },
) {
  const scope = sheet
    ? page.getByRole("dialog", {
        name: "Connect a model provider",
        exact: true,
      })
    : page.locator("main");
  const form = scope.getByRole("form", {
    name: "AI connection configuration",
    exact: true,
  });
  await form.waitFor();
  check(
    (await form.count()) === 1,
    `${row.id}: one shared AI configuration form`,
  );
  check(
    new URL(page.url()).pathname === routePath,
    `${row.id}: exact provider route`,
  );
  if (!sheet)
    check(
      (await page
        .getByRole("heading", { name: row.name, exact: true })
        .count()) === 1,
      `${row.id}: shared AI page keeps its provider heading`,
    );
  const observed = await sharedAiDefaults(form, row, preset, check);
  const setup = form.locator("details").filter({ hasText: "Connection setup" });
  const wasOpen = (await setup.getAttribute("open")) !== null;
  if (!wasOpen) await setup.locator("summary").click();
  const custody = await setup.innerText();
  check(
    /Token credential/.test(custody) &&
      /current vault/.test(custody) &&
      /only to the configured endpoint/.test(custody),
    `${row.id}: visible setup explains vault custody and endpoint authority`,
  );
  const layout = await sharedAiLayout(page, form);
  check(
    layout.document <= layout.width && layout.right <= layout.width,
    `${row.id}: shared AI configuration has no horizontal overflow`,
  );
  if (phone) {
    const under = layout.controls.filter(
      (control) => control.height + 0.5 < TOUCH_FLOOR,
    );
    check(
      under.length === 0,
      `${row.id}: shared AI inputs, selects and actions meet the 44px phone floor${under.length ? ` (${JSON.stringify(under)})` : ""}`,
    );
  }
  if (!wasOpen) await setup.locator("summary").click();
  record(
    "AI-CONFIGURATION",
    JSON.stringify({
      providerId: row.id,
      expectedRoutePath: routePath,
      expectedPreset: preset,
      observed: { pathname: new URL(page.url()).pathname, ...observed },
      sheet,
      layout,
    }),
  );
  if (sheet) {
    await scope.getByRole("button", { name: "Close", exact: true }).click();
    await form.waitFor({ state: "detached" });
    check(
      new URL(page.url()).pathname === `${base}connections`,
      `${row.id}: closing shared AI configuration returns to the catalog`,
    );
  }
}
