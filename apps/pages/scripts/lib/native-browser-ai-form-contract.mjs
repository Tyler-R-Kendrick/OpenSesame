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

function sharedAiDefaultFields(preset) {
  const azure = preset.azure;
  const key = azure
    ? azure.credential === "api-key"
      ? "Azure API key"
      : "Entra access token"
    : "API key";
  const fields = [
    ["Connection name", preset.name],
    ["API family", preset.family],
    [azure ? "Azure resource endpoint" : "API base URL", preset.baseUrl],
    [azure ? "Deployment ID" : "Model ID", ""],
    [
      azure ? "Azure authentication" : "Authentication",
      azure?.credential ?? "api-key",
    ],
    [key, ""],
  ];
  if (azure) fields.push(["Azure API mode", azure.api]);
  if (azure?.api === "dated-chat")
    fields.push(["Azure API version", azure.apiVersion]);
  return {
    fields,
    key,
    auth: azure ? "Azure authentication" : "Authentication",
  };
}

async function sharedAiDefaults(form, row, preset, check) {
  const defaults = sharedAiDefaultFields(preset);
  const fields = {};
  for (const [label, expected] of defaults.fields) {
    const field = form.getByLabel(label, { exact: true });
    const value = await field.inputValue();
    check(
      value === expected,
      `${row.id}: ${label} has its public provider default`,
    );
    const configurable = [
      "API family",
      defaults.auth,
      "Azure API mode",
    ].includes(label)
      ? await field.isEnabled()
      : await field.isEditable();
    check(configurable, `${row.id}: ${label} is configurable`);
    fields[label] =
      label === defaults.key
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
    .getByLabel(defaults.auth, { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  check(
    JSON.stringify(authentication) ===
      JSON.stringify(
        preset.azure ? ["api-key", "entra-token"] : ["api-key", "none"],
      ),
    `${row.id}: ${preset.azure ? "API key and Entra token authentication" : "API key and unauthenticated endpoints"} are selectable`,
  );
  const apiKeyType = await form
    .getByLabel(defaults.key, { exact: true })
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
  const apiModes = await sharedAiModeDefaults(form, row, preset, check);
  return {
    fields,
    families,
    authentication,
    apiModes,
    apiKeyType,
    actionsDisabled,
  };
}

async function sharedAiModeDefaults(form, row, preset, check) {
  if (!preset.azure) return undefined;
  const modes = await form
    .getByLabel("Azure API mode", { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  check(
    JSON.stringify(modes) === JSON.stringify(["v1", "dated-chat"]),
    `${row.id}: Azure exposes explicit v1 and dated Chat modes`,
  );
  if (preset.azure.api === "v1")
    check(
      (await form.getByLabel("Azure API version", { exact: true }).count()) ===
        0,
      `${row.id}: v1 does not collect an unrelated dated API version`,
    );
  return modes;
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
