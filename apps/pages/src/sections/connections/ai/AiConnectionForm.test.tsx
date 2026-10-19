/** @vitest-environment jsdom */
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { commitAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { AiConnectionForm } from "./AiConnectionForm.js";
import { AiConnectionPanels } from "./AiConnectionPanels.js";
import { aiConnectionUiDependencies } from "./useAiConnection.js";
afterEach(cleanup);
installConnectorIntegration();

function mount(
  providerId: string,
  saved = false,
  mutate?: (draft: AiConnectionDraft) => void,
) {
  const draft = {
    ...aiConnectionDraft(providerId),
    baseUrl: "https://custom.example/v1",
    model: "custom-model",
    apiKey: saved ? "" : "private-ui-key",
  };
  mutate?.(draft);
  const onChange = vi.fn();
  const onSave = vi.fn();
  const onTest = vi.fn();
  const rendered = render(
    <AiConnectionForm
      draft={draft}
      saved={saved}
      busy={false}
      result=""
      failure=""
      onChange={onChange}
      onSave={onSave}
      onTest={onTest}
    />,
  );
  return { ...rendered, draft, onChange, onSave, onTest };
}

it("uses the common BYO form to expose five genuinely different API families", async () => {
  const state = mount("byo-ai");
  const options = within(screen.getByLabelText("API family")).getAllByRole(
    "option",
  );
  expect(options.map((option) => option.textContent)).toEqual([
    "Amazon Bedrock Converse",
    "OpenAI Chat Completions",
    "OpenAI Responses",
    "Anthropic Messages",
    "Gemini Generate Content",
  ]);
  await choose("API family", "anthropic_messages");
  expect(state.onChange).toHaveBeenCalledWith("family", "anthropic_messages");
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "https://custom.example/v1",
  );
});

const secret = "controlled-azure-ui-key";
const endpoint = "https://custom.example/resource-mount";
function action(name = "Test AI connection") {
  return screen.getByRole("button", { name });
}
async function controlled(
  providerId = "azure-openai",
  previous?: AiConnectionDraft,
) {
  connectorIntegration();
  const saved = previous
    ? await commitAiConnection(previous, "fixture-vault", "", vi.fn())
    : undefined;
  const test = vi
    .spyOn(aiConnectionUiDependencies, "test")
    .mockResolvedValue("Model inference verified");
  const save = vi
    .spyOn(aiConnectionUiDependencies, "save")
    .mockImplementation((draft) =>
      commitAiConnection(draft, "fixture-vault", "", vi.fn()),
    );
  const flash = vi.fn();
  render(
    <AiConnectionPanels
      providerId={providerId}
      connectionId={saved?.connectionId}
      onFlash={flash}
    />,
  );
  return { test, save, flash };
}
async function enterAzure(label = "Azure API key") {
  await userEvent.type(
    screen.getByLabelText("Azure resource endpoint"),
    endpoint,
  );
  await userEvent.type(screen.getByLabelText("Deployment ID"), "deployment-01");
  await userEvent.type(screen.getByLabelText(label), secret);
}
async function replace(label: string, value: string) {
  await userEvent.clear(screen.getByLabelText(label));
  await userEvent.type(screen.getByLabelText(label), value);
}

async function choose(label: string, value: string) {
  await userEvent.selectOptions(screen.getByLabelText(label), value);
}
async function datedOverride(state: Awaited<ReturnType<typeof controlled>>) {
  await userEvent.click(screen.getByText("Connection setup"));
  await choose("Output token parameter", "max_completion_tokens");
  await replace("Azure API version", "2024-06-01");
  await choose("Azure authentication", "entra-token");
  await choose("Azure authentication", "api-key");
  await replace("Connection name", "Dated explicit override");
  await userEvent.type(screen.getByLabelText("Azure API key"), secret);
  await userEvent.click(action("Save AI connection"));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
  expect(state.save.mock.lastCall?.[0].tokenParameter).toBe(
    "max_completion_tokens",
  );
}

it.each(["azure-openai", "byo-ai"])(
  "controls %s v1 and dated Chat drafts through Test and Save without stale results",
  async (providerId) => {
    const state = await controlled(providerId);
    if (providerId === "byo-ai") await choose("Endpoint type", "azure");
    expect(screen.getByLabelText("Azure resource endpoint")).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByLabelText("Deployment ID")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Azure API mode")).toHaveProperty(
      "value",
      "v1",
    );
    expect(screen.queryByLabelText("Authentication")).toBeNull();
    if (providerId === "azure-openai")
      expect(screen.queryByLabelText("Endpoint type")).toBeNull();
    expect(action()).toHaveProperty("disabled", true);
    await enterAzure();
    await userEvent.click(action());
    expect(
      await screen.findByRole("img", { name: "Model inference verified" }),
    ).toBeTruthy();
    expect(state.test).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId,
        tokenParameter: "max_completion_tokens",
        baseUrl: endpoint,
        model: "deployment-01",
        apiKey: secret,
        azure: { api: "v1", credential: "api-key" },
      }),
      undefined,
    );
    await choose("API family", "openai_responses");
    await choose("Azure API mode", "dated-chat");
    expect(screen.getByLabelText("API family")).toHaveProperty(
      "value",
      "openai_chat",
    );
    expect(
      screen.getByRole("option", { name: "OpenAI Responses" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.queryByRole("img", { name: "Model inference verified" }),
    ).toBeNull();
    expect(screen.getByLabelText("Azure API key")).toHaveProperty("value", "");
    await userEvent.type(
      screen.getByLabelText("Azure API version"),
      "2024-02-31",
    );
    await userEvent.type(screen.getByLabelText("Azure API key"), secret);
    expect(action()).toHaveProperty("disabled", true);
    await replace("Azure API version", "2024-10-21");
    await userEvent.type(screen.getByLabelText("Azure API key"), secret);
    await userEvent.click(action());
    await waitFor(() => expect(state.test).toHaveBeenCalledTimes(2));
    expect(state.test.mock.lastCall?.[0].azure).toEqual({
      api: "dated-chat",
      apiVersion: "2024-10-21",
      credential: "api-key",
    });
    expect(state.test.mock.lastCall?.[0].tokenParameter).toBe("max_tokens");
    await userEvent.click(action("Save AI connection"));
    await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
    expect(state.save.mock.lastCall?.[0].tokenParameter).toBe("max_tokens");
    await datedOverride(state);
    await choose("Azure API mode", "v1");
    expect(screen.queryByLabelText("Azure API version")).toBeNull();
    await choose("API family", "openai_responses");
    await userEvent.type(screen.getByLabelText("Azure API key"), secret);
    await userEvent.click(action("Save AI connection"));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(3));
    expect(state.save.mock.lastCall?.[0]).toMatchObject({
      family: "openai_responses",
      azure: { api: "v1", credential: "api-key" },
      apiKey: secret,
    });
    expect(state.save.mock.lastCall?.[0].azure).not.toHaveProperty(
      "apiVersion",
    );
    expect(screen.getByLabelText("Azure API key")).toHaveProperty("value", "");
    expect(document.body.textContent).not.toContain(secret);
  },
);

it.each(["anthropic_messages", "gemini_generate_content"])(
  "composes BYO Azure and clears it for %s",
  async (family) => {
    const state = await controlled("byo-ai");
    expect(screen.getByLabelText("Endpoint type")).toHaveProperty(
      "value",
      "standard",
    );
    await choose("Endpoint type", "azure");
    await choose("Azure authentication", "entra-token");
    expect(screen.getByLabelText("Entra access token")).toHaveProperty(
      "type",
      "password",
    );
    await enterAzure("Entra access token");
    await userEvent.click(action());
    expect(
      await screen.findByRole("img", { name: "Model inference verified" }),
    ).toBeTruthy();
    expect(state.test.mock.lastCall?.[0]).toMatchObject({
      providerId: "byo-ai",
      authentication: "api-key",
      apiKey: secret,
      azure: { api: "v1", credential: "entra-token" },
    });
    await choose("API family", family);
    expect(screen.queryByLabelText("Azure API mode")).toBeNull();
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Model ID")).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Model inference verified" }),
    ).toBeNull();
  },
);

it("keeps saved Forget/workspace visible while target edits require a replacement", async () => {
  const previous: AiConnectionDraft = {
    ...aiConnectionDraft("azure-openai"),
    baseUrl: endpoint,
    model: "deployment-01",
    apiKey: secret,
  };
  const state = await controlled("azure-openai", previous);
  expect(screen.getByLabelText("Azure API key")).toHaveProperty("value", "");
  expect(action()).toHaveProperty("disabled", false);
  await replace("Connection name", "Renamed Azure");
  await replace("Azure resource endpoint", `${endpoint}/`);
  expect(action()).toHaveProperty("disabled", false);
  await choose("Azure authentication", "entra-token");
  expect(screen.getByLabelText("Entra access token")).toHaveProperty(
    "value",
    "",
  );
  expect(action()).toHaveProperty("disabled", true);
  expect(action("Forget AI connection")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Model inference" })).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Entra access token"), secret);
  expect(action()).toHaveProperty("disabled", false);
  await replace("Azure resource endpoint", `${endpoint}/other`);
  expect(action()).toHaveProperty("disabled", true);
  await userEvent.type(screen.getByLabelText("Entra access token"), secret);
  await userEvent.click(action());
  await waitFor(() => expect(state.test).toHaveBeenCalledOnce());
  expect(state.test.mock.lastCall?.[0]).toMatchObject({
    baseUrl: `${endpoint}/other`,
    azure: { api: "v1", credential: "entra-token" },
    apiKey: secret,
  });
});

it("disables every field and action while a controlled Test is pending", async () => {
  const state = await controlled();
  let finish = (_value: string) => {};
  state.test.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await enterAzure();
  await userEvent.click(action());
  const form = screen.getByRole("form", {
    name: "AI connection configuration",
  });
  for (const control of form.querySelectorAll("input,select,button"))
    expect(control).toHaveProperty("disabled", true);
  finish("Model inference verified");
  expect(
    await screen.findByRole("img", { name: "Model inference verified" }),
  ).toBeTruthy();
});

it("clears an entered key when choosing supplied Entra authentication and redacts failures", async () => {
  const state = await controlled();
  await enterAzure();
  await choose("Azure authentication", "entra-token");
  expect(screen.getByLabelText("Entra access token")).toHaveProperty(
    "value",
    "",
  );
  expect(action()).toHaveProperty("disabled", true);
  await userEvent.type(screen.getByLabelText("Entra access token"), secret);
  state.test.mockRejectedValue(new Error(`Refused ${secret}`));
  await userEvent.click(action());
  await waitFor(() => expect(state.flash).toHaveBeenCalledOnce());
  expect(document.body.textContent).not.toContain(secret);
  expect(JSON.stringify(state.flash.mock.calls)).not.toContain(secret);
  await choose("Azure API mode", "dated-chat");
  expect(screen.queryByRole("img", { name: /Refused/ })).toBeNull();
});

it.each([
  {
    providerId: "openai",
    options: ["OpenAI Chat Completions", "OpenAI Responses"],
  },
  { providerId: "anthropic", options: ["Anthropic Messages"] },
  { providerId: "gemini", options: ["Gemini Generate Content"] },
])(
  "derives $providerId partner choices while keeping the same editable endpoint and model fields",
  ({ providerId, options }) => {
    mount(providerId);
    expect(
      within(screen.getByLabelText("API family"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(options);
    expect(screen.getByLabelText("API base URL")).toBeTruthy();
    expect(screen.getByLabelText("Model ID")).toBeTruthy();
  },
);

it("tests separately from saving and keeps a saved credential write-only", async () => {
  const state = mount("openai", true);
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  await userEvent.click(
    screen.getByRole("button", { name: "Test AI connection" }),
  );
  expect(state.onTest).toHaveBeenCalledOnce();
  expect(state.onSave).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Save AI connection" }),
  );
  expect(state.onSave).toHaveBeenCalledOnce();
});

it.each(["Azure resource endpoint", "Deployment ID", "Azure API key"])(
  "disables Test and Save without %s",
  async (label) => {
    const state = await controlled();
    await enterAzure();
    await userEvent.clear(screen.getByLabelText(label));
    expect(action()).toHaveProperty("disabled", true);
    expect(action("Save AI connection")).toHaveProperty("disabled", true);
    expect(state.test).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
  },
);

it.each(["authentication", "azure"])(
  "disables Test and Save for invalid %s state",
  (field) => {
    mount("azure-openai", false, (draft) => {
      Reflect.set(
        draft,
        field,
        field === "authentication"
          ? "none"
          : { api: "unknown", credential: "api-key" },
      );
    });
    expect(action()).toHaveProperty("disabled", true);
    expect(action("Save AI connection")).toHaveProperty("disabled", true);
  },
);
