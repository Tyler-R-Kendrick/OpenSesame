/** Real shared/native AI forms → actual HTTP fixture → vault-owned Token items. */
import { expect } from "@playwright/test";
import {
  AI_FIXTURE_KEY,
  AI_FIXTURE_MODEL,
} from "./ai-connection-http-fixture.mjs";
import { verifyAzureAiLifecycle } from "./azure-ai-browser-lifecycle.mjs";
import { addCapabilities, unlockWithPin } from "./pages-journey.mjs";
import { enableBackendConnections } from "./secret-backend-browser.mjs";

const CASES = [
  {
    providerId: "openai",
    family: "openai_chat",
    path: "/custom/v1/chat/completions",
  },
  {
    providerId: "openai",
    family: "openai_responses",
    path: "/custom/v1/responses",
  },
  {
    providerId: "byo-ai",
    family: "anthropic_messages",
    path: "/custom/v1/messages",
  },
  {
    providerId: "byo-ai",
    family: "gemini_generate_content",
    path: `/custom/v1/models/${AI_FIXTURE_MODEL}:generateContent`,
  },
  {
    providerId: "anthropic",
    family: "anthropic_messages",
    path: "/custom/v1/messages",
  },
  {
    providerId: "gemini",
    family: "gemini_generate_content",
    path: `/custom/v1/models/${AI_FIXTURE_MODEL}:generateContent`,
  },
];

async function visit(page, base, route) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}
async function open(page, base, providerId) {
  await visit(page, base, `settings/connections/${providerId}`);
  await page
    .getByRole("form", { name: "AI connection configuration", exact: true })
    .waitFor();
}
function requestsSince(fixture, before, family) {
  return fixture.requests
    .slice(before)
    .filter((request) => request.family === family);
}
function fields(fixture, entry) {
  return {
    baseLabel: entry.azure ? "Azure resource endpoint" : "API base URL",
    modelLabel: entry.azure ? "Deployment ID" : "Model ID",
    keyLabel: entry.keyLabel ?? "API key",
    key: entry.key ?? AI_FIXTURE_KEY,
    model: entry.model ?? AI_FIXTURE_MODEL,
    baseUrl: entry.mount ? `${fixture.origin}${entry.mount}` : fixture.baseUrl,
  };
}
async function datedTokenParameter(page, select = false) {
  const panel = page.getByRole("region", {
    name: "AI configuration",
    exact: true,
  });
  const summary = panel.getByText("Connection setup", { exact: true });
  if ((await summary.locator("..").getAttribute("open")) === null)
    await summary.click();
  const field = panel.getByLabel("Output token parameter", { exact: true });
  if (select) await field.selectOption("max_tokens");
  await expect(field).toHaveValue("max_tokens");
}
async function configure(page, fixture, entry, name, check, width) {
  const panel = page.getByRole("region", {
    name: "AI configuration",
    exact: true,
  });
  const form = fields(fixture, entry);
  await panel.getByLabel("Connection name", { exact: true }).fill(name);
  await panel
    .getByLabel("API family", { exact: true })
    .selectOption(entry.family);
  await panel.getByLabel(form.baseLabel, { exact: true }).fill(form.baseUrl);
  await panel.getByLabel(form.modelLabel, { exact: true }).fill(form.model);
  if (!entry.azure)
    await panel
      .getByLabel("Authentication", { exact: true })
      .selectOption("api-key");
  await panel.getByLabel(form.keyLabel, { exact: true }).fill(form.key);
  if (entry.dated) await datedTokenParameter(page, true);
  const before = fixture.requests.length;
  await panel
    .getByRole("button", { name: "Test AI connection", exact: true })
    .click();
  await panel
    .getByRole("img", { name: "Model inference verified", exact: true })
    .waitFor();
  const tested = requestsSince(fixture, before, entry.family);
  check(
    tested.length === 1 &&
      tested[0].authenticated &&
      tested[0].path === entry.path &&
      !tested[0].stream,
    `${width}: ${entry.providerId}/${entry.family} Test performs authenticated inference on its exact custom mount`,
  );
  await panel
    .getByRole("button", { name: "Save AI connection", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Model inference", exact: true })
    .waitFor();
  await expect(panel.getByLabel(form.keyLabel, { exact: true })).toHaveValue(
    "",
  );
  const saved = requestsSince(fixture, before, entry.family);
  check(
    saved.length === 2 &&
      saved.every(
        (request) => request.authenticated && request.path === entry.path,
      ),
    `${width}: ${entry.providerId}/${entry.family} Save independently verifies its actual protocol before retaining vault custody`,
  );
}

async function chooseAndColdReload(
  page,
  { base, fixture, entry, name, width, check, beforeReload },
) {
  const form = fields(fixture, entry);
  await visit(page, base, "settings/features/ai/support.local-ai");
  const select = page.getByRole("combobox", {
    name: "Inference model",
    exact: true,
  });
  const label = `${name} · ${form.model}`;
  await expect(
    select.getByRole("option", { name: label, exact: true }),
  ).toHaveCount(1);
  await select.selectOption({ label });
  await expect(
    page.getByRole("img", { name: "Saved.", exact: true }),
  ).toBeVisible();
  const selected = await select.inputValue();
  check(
    selected.startsWith("connection:"),
    `${width}: ${entry.providerId}/${entry.family} inference selection names the saved connection`,
  );
  await beforeReload();
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await visit(page, base, "settings/features/ai/support.local-ai");
  await expect(
    page.getByRole("combobox", { name: "Inference model", exact: true }),
  ).toHaveValue(selected);
  check(
    true,
    `${width}: ${entry.providerId}/${entry.family} exact inference choice survives cold reload and PIN unlock`,
  );
  await open(page, base, entry.providerId);
  const panel = page.getByRole("region", {
    name: "AI configuration",
    exact: true,
  });
  await expect(
    panel.getByLabel("Connection name", { exact: true }),
  ).toHaveValue(name);
  await expect(panel.getByLabel("API family", { exact: true })).toHaveValue(
    entry.family,
  );
  await expect(panel.getByLabel(form.baseLabel, { exact: true })).toHaveValue(
    form.baseUrl,
  );
  await expect(panel.getByLabel(form.modelLabel, { exact: true })).toHaveValue(
    form.model,
  );
  await expect(panel.getByLabel(form.keyLabel, { exact: true })).toHaveValue(
    "",
  );
  if (entry.dated) await datedTokenParameter(page);
  return selected;
}

async function verifyToken(page, { base, fixture, entry, name, width, check }) {
  const form = fields(fixture, entry);
  await visit(page, base, "vault?f=all");
  const title = `AI API key · ${name}`;
  const row = page.getByRole("treeitem").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await page.getByRole("button", { name: /^Reveal [Tt]oken$/ }).click();
  await expect(page.getByText(form.key, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Hide [Tt]oken$/ }).click();
  check(
    true,
    `${width}: ${entry.providerId}/${entry.family} API key is a real readable Token item after cold unlock`,
  );
  check(
    await page.evaluate(
      (secret) => !JSON.stringify(Object.values(localStorage)).includes(secret),
      form.key,
    ),
    `${width}: ${entry.providerId}/${entry.family} API key is absent from plaintext browser configuration storage`,
  );
  await open(page, base, entry.providerId);
}

async function infer(page, { fixture, entry, width, check }) {
  const region = page.getByRole("region", {
    name: "Model inference",
    exact: true,
  });
  for (const stream of [false, true]) {
    await region
      .getByLabel("Prompt", { exact: true })
      .fill(`Browser ${entry.family} ${stream ? "SSE" : "JSON"} ${width}`);
    await region
      .getByRole("checkbox", { name: "Stream response", exact: true })
      .setChecked(stream);
    const before = fixture.requests.length;
    await region
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect(region.getByLabel("Model answer", { exact: true })).toHaveText(
      entry.answer ?? `Fixture ${entry.family} answer`,
    );
    await expect(
      region.getByRole("button", { name: "Send prompt", exact: true }),
    ).toBeEnabled();
    const rows = requestsSince(fixture, before, entry.family);
    const path =
      stream && entry.family === "gemini_generate_content"
        ? `/custom/v1/models/${AI_FIXTURE_MODEL}:streamGenerateContent?alt=sse`
        : entry.path;
    check(
      rows.length === 1 &&
        rows[0].authenticated &&
        rows[0].path === path &&
        rows[0].stream === stream,
      `${width}: ${entry.providerId}/${entry.family} ${stream ? "genuine SSE" : "JSON"} inference uses the saved exact endpoint and auth`,
    );
  }
}

/** Caller supplies an unlocked real PIN vault, the built app, and the live fixture. */
export async function verifyAiConnections({
  page,
  base,
  fixture,
  width,
  check,
  beforeReload,
}) {
  await enableBackendConnections(page, base);
  await addCapabilities(page, ["On-device model"]);
  const beforePreflights = fixture.preflights.length;
  for (const entry of CASES) {
    const name = `AI ${entry.providerId} ${entry.family} ${width}`;
    await open(page, base, entry.providerId);
    await configure(page, fixture, entry, name, check, width);
    const context = { base, fixture, entry, name, width, check, beforeReload };
    await chooseAndColdReload(page, context);
    await verifyToken(page, context);
    await infer(page, context);
  }
  check(
    fixture.preflights.length > beforePreflights,
    `${width}: real browser CORS preflights reached the AI HTTP fixture`,
  );
  check(
    fixture.errors.length === 0,
    `${width}: all six configurations across four inference protocols passed the fixture's independent request validation`,
  );
  await verifyAzureAiLifecycle(
    { page, base, fixture, width, check, beforeReload },
    {
      beforeReload,
      visit,
      open,
      configure,
      chooseAndColdReload,
      verifyToken,
      infer,
    },
  );
}
