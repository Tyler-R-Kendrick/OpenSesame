/** Actual Azure configuration, selected Support and socket-backed credential lifetime. */
import { expect } from "@playwright/test";
import {
  AZURE_FIXTURE_ENTRA,
  AZURE_FIXTURE_KEY,
} from "./ai-connection-http-fixture.mjs";
import { ensureModelsOff } from "./enable-capabilities.mjs";
import { addCapabilities, lockVault, unlockWithPin } from "./pages-journey.mjs";

const CASES = [
  {
    providerId: "azure-openai",
    family: "openai_chat",
    mount: "/azure/native-chat",
    model: "native-chat-deployment",
    path: "/azure/native-chat/openai/v1/chat/completions",
    credential: "api-key",
  },
  {
    providerId: "azure-openai",
    family: "openai_responses",
    mount: "/azure/native-responses",
    model: "native-responses-deployment",
    path: "/azure/native-responses/openai/v1/responses",
    credential: "entra-token",
  },
  {
    providerId: "byo-ai",
    family: "openai_chat",
    mount: "/azure/byo-chat",
    model: "byo-chat-deployment",
    path: "/azure/byo-chat/openai/deployments/byo-chat-deployment/chat/completions?api-version=2024-06-01",
    credential: "entra-token",
    dated: true,
  },
  {
    providerId: "byo-ai",
    family: "openai_responses",
    mount: "/azure/byo-responses",
    model: "byo-responses-deployment",
    path: "/azure/byo-responses/openai/v1/responses",
    credential: "api-key",
  },
].map((entry) => ({
  ...entry,
  azure: true,
  key: entry.credential === "api-key" ? AZURE_FIXTURE_KEY : AZURE_FIXTURE_ENTRA,
  keyLabel:
    entry.credential === "api-key" ? "Azure API key" : "Entra access token",
  answer: `Fixture Azure ${entry.model} answer`,
}));
async function azureControls(page, entry) {
  const mode = page.getByLabel("Azure API mode", { exact: true });
  if (await mode.count()) await mode.selectOption("v1");
  await page
    .getByLabel("API family", { exact: true })
    .selectOption(entry.family);
  if (entry.providerId === "byo-ai")
    await page
      .getByLabel("Endpoint type", { exact: true })
      .selectOption("azure");
  await page
    .getByLabel("Azure API mode", { exact: true })
    .selectOption(entry.dated ? "dated-chat" : "v1");
  if (entry.dated)
    await page
      .getByLabel("Azure API version", { exact: true })
      .fill("2024-06-01");
  await page
    .getByLabel("Azure authentication", { exact: true })
    .selectOption(entry.credential);
}
async function restoredMetadata(page, entry) {
  await expect(page.getByLabel("Azure API mode", { exact: true })).toHaveValue(
    entry.dated ? "dated-chat" : "v1",
  );
  await expect(
    page.getByLabel("Azure authentication", { exact: true }),
  ).toHaveValue(entry.credential);
  const version = page.getByLabel("Azure API version", { exact: true });
  if (entry.dated) await expect(version).toHaveValue("2024-06-01");
  else await expect(version).toHaveCount(0);
}
async function remoteSupport(context, api) {
  const { page, base } = context;
  await api.visit(page, base, "settings/features");
  await ensureModelsOff(page, { origin: new URL(page.url()).origin, base });
  await api.visit(page, base, "settings/features");
  await addCapabilities(page, ["Remote support model"]);
  await api.visit(page, base, "vault?f=all");
}
async function supportQuestion(context, marker) {
  const { page } = context;
  await page.getByRole("button", { name: /^Support/ }).click();
  const sheet = page.getByRole("dialog", { name: "Support", exact: true });
  await sheet
    .getByLabel("Ask about this screen", { exact: true })
    .fill(
      `Where is lock ${marker}? Email person@example.com, token=private-token`,
    );
  const beforeAnswers = await sheet
    .getByRole("article", { name: "support answered", exact: true })
    .count();
  await sheet.getByRole("button", { name: "Ask", exact: true }).click();
  return { sheet, beforeAnswers };
}
function supportPayload(fixture, row, marker) {
  const body = fixture.bodies.get(row.id);
  const messages = body.messages ?? body.input;
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe("system");
  expect(messages[1].role).toBe("user");
  const payload = JSON.parse(messages[1].content);
  expect(Object.keys(payload).sort()).toEqual([
    "featureIds",
    "pageId",
    "question",
    "route",
    "version",
  ]);
  expect(payload).toMatchObject({
    version: 2,
    pageId: "pages",
    route: "/vault",
    question: `Where is lock ${marker}? Email [redacted address], [redacted credential]`,
  });
  expect(Array.isArray(payload.featureIds)).toBe(true);
  expect(payload.featureIds.length).toBeLessThanOrEqual(32);
  for (const id of payload.featureIds)
    expect(id).toMatch(/^[a-z][a-z0-9._/-]{0,63}$/);
  for (const secret of [
    "person@example.com",
    "private-token",
    "private history",
    AZURE_FIXTURE_KEY,
    AZURE_FIXTURE_ENTRA,
  ])
    expect(JSON.stringify(body)).not.toContain(secret);
  expect(body.stream).toBe(false);
}
async function askSelected(context) {
  const { page, fixture, entry, width, check } = context;
  const before = fixture.requests.length;
  const marker = `${entry.model.replaceAll("-", " ")} ${width}`;
  const { sheet, beforeAnswers } = await supportQuestion(context, marker);
  await expect.poll(() => fixture.requests.length).toBe(before + 1);
  const answers = sheet.getByRole("article", {
    name: "support answered",
    exact: true,
  });
  await expect(answers).toHaveCount(beforeAnswers + 1);
  await expect(answers.last().locator(".support__text")).toHaveText(
    entry.answer,
  );
  const rows = fixture.requests.slice(before);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    path: entry.path,
    authenticated: true,
    stream: false,
  });
  supportPayload(fixture, rows[0], marker);
  check(
    true,
    `${width}: selected Support uses exact ${entry.model} Azure target and redacted semantic-only question`,
  );
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}
async function cancelSupport(context) {
  const { fixture, entry, width, check } = context;
  const held = fixture.holdNext(entry.path, false);
  try {
    const { sheet } = await supportQuestion(context, "cancelled");
    await expect.poll(() => held.started).toBe(true);
    const answers = sheet.getByRole("article", {
      name: "support answered",
      exact: true,
    });
    const before = await answers.count();
    held.armCancellation("support-cancel");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => held.closed).toBe(true);
    await expect(
      sheet.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(0);
    held.release();
    await expect(answers).toHaveCount(before);
    check(
      true,
      `${width}: actual Support Cancel closes held Azure JSON response with no late answer`,
    );
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
  } finally {
    held.release();
  }
}
async function cancelStream(context, api, lock) {
  const { page, base, fixture, entry, width, check } = context;
  await api.open(page, base, entry.providerId);
  const region = page.getByRole("region", {
    name: "Model inference",
    exact: true,
  });
  await region
    .getByLabel("Prompt", { exact: true })
    .fill("Held browser stream");
  await region
    .getByRole("checkbox", { name: "Stream response", exact: true })
    .setChecked(true);
  const held = fixture.holdNext(entry.path, true);
  const before = fixture.requests.length;
  try {
    await region
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect.poll(() => held.started).toBe(true);
    await expect(region.getByLabel("Model answer", { exact: true })).toHaveText(
      "Fixture ",
    );
    held.armCancellation(lock ? "vault-lock" : "route-unmount");
    if (lock) await lockVault(page);
    else
      await page
        .getByRole("link", { name: "Connections", exact: true })
        .click();
    await expect.poll(() => held.closed).toBe(true);
    held.release();
    if (lock) await unlockWithPin(page);
    await api.open(page, base, entry.providerId);
    await expect(
      page
        .getByRole("region", { name: "Model inference", exact: true })
        .getByLabel("Model answer", { exact: true }),
    ).toHaveText("");
    expect(fixture.requests).toHaveLength(before + 1);
    check(
      true,
      `${width}: Azure SSE ${lock ? "vault lock/unlock" : "route unmount"} closes real response without late answer or automatic replay`,
    );
  } finally {
    held.release();
  }
}
async function blankEdit(context, api) {
  const { page, base, fixture, entry, width, check } = context;
  await api.open(page, base, entry.providerId);
  const before = fixture.requests.length;
  await expect(page.getByLabel(entry.keyLabel, { exact: true })).toHaveValue(
    "",
  );
  await page
    .getByLabel("Azure resource endpoint", { exact: true })
    .fill(`${fixture.origin}/azure/decoy`);
  for (const name of ["Test AI connection", "Save AI connection"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Forget AI connection", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Integrations", exact: true }),
  ).toBeVisible();
  await api.open(page, base, entry.providerId);
  await expect(
    page.getByLabel("Azure resource endpoint", { exact: true }),
  ).toHaveValue(`${fixture.origin}${entry.mount}`);
  expect(fixture.requests).toHaveLength(before);
  check(
    true,
    `${width}: changed-resource blank key disables Test/Save and unsaved edit makes no HTTP request`,
  );
  await api.visit(page, base, "vault?f=all");
  await askSelected(context);
}
async function forget(context, api, selected) {
  const { page, base, fixture, entry, name, width, check } = context;
  await api.visit(page, base, "vault?f=all");
  const tokens = page
    .getByRole("treeitem")
    .filter({ hasText: "AI API key · " });
  const others = (await tokens.allTextContents()).filter(
    (text) => !text.includes(`AI API key · ${name}`),
  );
  await api.open(page, base, entry.providerId);
  const before = fixture.requests.length;
  await page
    .getByRole("button", { name: "Forget AI connection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Forget AI connection", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Model inference", exact: true }),
  ).toHaveCount(0);
  await api.visit(page, base, "vault?f=all");
  await expect(
    page.getByRole("treeitem").filter({ hasText: `AI API key · ${name}` }),
  ).toHaveCount(0);
  for (const text of others)
    await expect(
      page.getByRole("treeitem").filter({ hasText: text }),
    ).toHaveCount(1);
  await api.visit(page, base, "settings/features");
  await addCapabilities(page, ["On-device model"]);
  await expect(
    page
      .getByRole("combobox", { name: "Inference model", exact: true })
      .locator(`option[value="${selected}"]`),
  ).toHaveCount(0);
  await api.beforeReload();
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await api.visit(page, base, "settings/features");
  await expect(
    page
      .getByRole("combobox", { name: "Inference model", exact: true })
      .locator(`option[value="${selected}"]`),
  ).toHaveCount(0);
  await api.open(page, base, entry.providerId);
  await expect(
    page.getByLabel(
      entry.providerId === "byo-ai" ? "API key" : "Azure API key",
      { exact: true },
    ),
  ).toHaveValue("");
  await expect(
    page.getByRole("region", { name: "Model inference", exact: true }),
  ).toHaveCount(0);
  await remoteSupport(context, api);
  await page.getByRole("button", { name: /^Support/ }).click();
  const sheet = page.getByRole("dialog", { name: "Support", exact: true });
  await expect(
    sheet.getByLabel("Search the written help", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByLabel("Ask about this screen", { exact: true }),
  ).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  expect(fixture.requests).toHaveLength(before);
  check(
    true,
    `${width}: durable Forget removes only owning Token/Features option across cold PIN reload with no inference`,
  );
}
function checkCors(context) {
  const { fixture, entry, page, width, check } = context;
  const header = entry.credential === "api-key" ? "api-key" : "authorization";
  const origin = new URL(page.url()).origin;
  check(
    fixture.preflights.some(
      (row) =>
        row.path === entry.path &&
        row.origin === origin &&
        row.method === "POST" &&
        row.headers.split(",").includes(header),
    ),
    `${width}: ${entry.model} real CORS preflight authorizes exact target and ${header} header`,
  );
}
export async function verifyAzureAiLifecycle(context, api) {
  const { page, base, fixture, width, check } = context;
  for (const entry of CASES) {
    const current = {
      ...context,
      entry,
      name: `Azure ${entry.model} ${width}`,
    };
    await api.visit(page, base, "settings/features");
    await addCapabilities(page, ["On-device model"]);
    await api.open(page, base, entry.providerId);
    await azureControls(page, entry);
    await api.configure(page, fixture, entry, current.name, check, width);
    const selected = await api.chooseAndColdReload(page, current);
    await restoredMetadata(page, entry);
    await api.verifyToken(page, current);
    await api.infer(page, current);
    checkCors(current);
    await remoteSupport(current, api);
    await askSelected(current);
    if (entry.credential === "entra-token" && !entry.dated) {
      await cancelSupport(current);
      await cancelStream(current, api, false);
      await cancelStream(current, api, true);
    }
    if (entry.dated || entry.credential === "api-key")
      await blankEdit(current, api);
    if (entry.model === "byo-responses-deployment")
      await forget(current, api, selected);
  }
  check(
    fixture.errors.length === 0,
    `${width}: four Azure native/BYO targets passed independent protocol and credential lifecycle validation`,
  );
  await api.visit(page, base, "settings/features");
  await addCapabilities(page, ["On-device model"]);
}
