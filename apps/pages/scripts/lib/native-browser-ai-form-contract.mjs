/** Configuration coverage only: no credentials, inference or provider auth. */
import { TOUCH_FLOOR } from "./mobile-contract.mjs";
import {
  cloudAiDefaults,
  selectOptions,
  sharedDisabledActions,
} from "./native-browser-ai-cloud-contract.mjs";
import { nativeIsAiImageFamily } from "./native-browser-catalog-projection.mjs";

async function sharedAiLayout(page, form) {
  const read = () =>
    form.evaluate((node) => {
      const scope = node.closest('[role="dialog"]') ?? node;
      return {
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        right: scope.getBoundingClientRect().right,
        controls: [...scope.querySelectorAll("input, textarea, select, button")]
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
  const image = nativeIsAiImageFamily(preset.family);
  const azure = preset.azure;
  const prediction = preset.family === "replicate_predictions";
  const speech = [
    "elevenlabs_scribe",
    "deepgram_listen",
    "assemblyai_transcript",
  ].includes(preset.family);
  const key = azure
    ? azure.credential === "api-key"
      ? "Azure API key"
      : "Entra access token"
    : "API key";
  const fields = [
    ["Connection name", preset.name],
    ["API family", preset.family],
    [azure ? "Azure resource endpoint" : "API base URL", preset.baseUrl],
    [azure ? "Deployment ID" : "Model ID", preset.model ?? ""],
    ...(preset.providerId === "ollama" ? [] : [[key, ""]]),
  ];
  if (!prediction && !speech && !image)
    fields.push([
      azure ? "Azure authentication" : "Authentication",
      azure?.credential ??
        (preset.providerId === "ollama" ? "none" : "api-key"),
    ]);
  fields.push(...sharedAiAzureFields(azure));
  return {
    fields,
    key,
    auth: azure ? "Azure authentication" : "Authentication",
  };
}

function sharedAiAzureFields(azure) {
  if (!azure) return [];
  const fields = [["Azure API mode", azure.api]];
  if (azure.api === "dated-chat")
    fields.push(["Azure API version", azure.apiVersion]);
  return fields;
}

async function sharedAiProtocolDefaults(form, row, preset, defaults, check) {
  const prediction = preset.family === "replicate_predictions";
  const speech = [
    "elevenlabs_scribe",
    "deepgram_listen",
    "assemblyai_transcript",
  ].includes(preset.family);
  const image = nativeIsAiImageFamily(preset.family);
  const finite = prediction || speech || image;
  const authentication = finite ? [] : await selectOptions(form, defaults.auth);
  if (prediction)
    check(
      (await form
        .getByLabel("Prediction verification input JSON", { exact: true })
        .inputValue()) === "",
      `${row.id}: finite model-specific verification JSON starts empty`,
    );
  check(
    finite
      ? (await form.getByLabel("Authentication", { exact: true }).count()) === 0
      : JSON.stringify(authentication) ===
          JSON.stringify(
            preset.azure ? ["api-key", "entra-token"] : ["api-key", "none"],
          ),
    `${row.id}: ${prediction ? "prediction requires its API token without an unauthenticated mode" : speech ? "transcription requires its API key without an unauthenticated mode" : image ? "image generation requires its API key without an unauthenticated mode" : "published authentication choices are explicit"}`,
  );
  if (image)
    check(
      (await form
        .getByLabel("Verification image prompt", { exact: true })
        .inputValue()) === "",
      `${row.id}: image verification requires an explicit transient prompt`,
    );
  if (speech) await speechInputDefaults(form, row, check);
  return authentication;
}

async function sharedAiDefaults(form, row, preset, check) {
  if (preset.vertex || preset.bedrock)
    return cloudAiDefaults(form, row, preset, check);
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
  const families = await selectOptions(form, "API family");
  check(
    JSON.stringify(families) === JSON.stringify(preset.families),
    `${row.id}: supported inference API families are explicit`,
  );
  const authentication = await sharedAiProtocolDefaults(
    form,
    row,
    preset,
    defaults,
    check,
  );
  const { apiKeyType, actionsDisabled } = await sharedAiCredentialDefaults(
    form,
    row,
    preset,
    defaults,
    check,
  );
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

async function sharedAiCredentialDefaults(form, row, preset, defaults, check) {
  const anonymous = preset.providerId === "ollama";
  if (anonymous) {
    check(
      (await form.getByLabel(defaults.key, { exact: true }).count()) === 0,
      `${row.id}: anonymous local mode does not collect an API key`,
    );
    await form
      .getByLabel(defaults.auth, { exact: true })
      .selectOption("api-key");
    const key = form.getByLabel(defaults.key, { exact: true });
    check(
      (await key.inputValue()) === "" && (await key.isEditable()),
      `${row.id}: explicitly selected API-key mode exposes a blank editable key`,
    );
  }
  const apiKeyType = await form
    .getByLabel(defaults.key, { exact: true })
    .getAttribute("type");
  check(
    apiKeyType === "password",
    `${row.id}: the blank API key is write-only`,
  );
  const actionsDisabled = await sharedDisabledActions(form, row, check);
  if (anonymous) {
    await form.getByLabel(defaults.auth, { exact: true }).selectOption("none");
    check(
      (await form.getByLabel(defaults.key, { exact: true }).count()) === 0,
      `${row.id}: returning to anonymous mode removes the credential field`,
    );
  }
  return { apiKeyType, actionsDisabled };
}

async function speechInputDefaults(form, row, check) {
  check(
    (await form
      .getByLabel("Verification audio", { exact: true })
      .getAttribute("type")) === "file",
    `${row.id}: transcription requires local audio verification input`,
  );
  check(
    (await form.getByLabel("Prompt", { exact: true }).count()) === 0,
    `${row.id}: transcription does not invent a text prompt`,
  );
}

async function sharedAiModeDefaults(form, row, preset, check) {
  if (!preset.azure) return undefined;
  const modes = await selectOptions(form, "Azure API mode");
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

function custodyPatterns(preset) {
  if (nativeIsAiImageFamily(preset.family))
    return [
      /generate an actual PNG/,
      /may incur service charges/,
      /prompt and verification image are not saved/,
      /Cancel stops waiting and closes the request/,
      /does not confirm that provider processing or charges stopped/,
      /API key is sealed in the owning vault/,
      /configured native Tailscale HTTP transport/,
      /permit this browser origin and request headers for a direct browser connection/,
    ];
  if (preset.vertex)
    return [
      /private key stays in this browser/,
      /Only the issued access token reaches the configured model endpoint/,
      /write-only credential is saved in the owning vault/,
    ];
  if (preset.bedrock)
    return [
      /Credentials stay sealed in the owning vault/,
      /approved PWA network transport/,
      /permission to invoke this model/,
    ];
  if (preset.family === "replicate_predictions")
    return [
      /model owner\/name or an immutable version/,
      /model-specific JSON input/,
      /wait for terminal output/,
      /Verification input is transient and is not saved/,
      /API token stays in the owning vault/,
    ];
  if (preset.family === "stability_sd3")
    return [
      /Testing and saving generate an actual PNG/,
      /prompt and verification image are not saved/,
      /API key is sealed in the owning vault/,
      /native Tailscale HTTP transport/,
    ];
  return [
    /Token credential/,
    /current vault/,
    /only to the configured endpoint/,
  ];
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
  const prediction = preset.family === "replicate_predictions";
  const image = nativeIsAiImageFamily(preset.family);
  const plainSetup = prediction || image;
  const setup = plainSetup
    ? form.locator("p").filter({
        hasText: prediction
          ? "Enter the model owner/name"
          : "Testing and saving generate an actual PNG",
      })
    : form.locator("details").filter({ hasText: "Connection setup" });
  const wasOpen = plainSetup || (await setup.getAttribute("open")) !== null;
  if (!wasOpen) await setup.locator("summary").click();
  const custody = await setup.innerText();
  check(
    custodyPatterns(preset).every((pattern) => pattern.test(custody)),
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
