/** @vitest-environment jsdom */
import { commitAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { AiProviderSheet } from "./AiProviderSheet.js";
import { aiProviderSheetTarget } from "./ai-provider-sheet-target.js";
import { aiConnectionUiDependencies } from "./useAiConnection.js";

installConnectorIntegration();
const SECRET = "private-ai-sheet-credential";

function mount(providerId = "xai") {
  const fixture = connectorIntegration();
  const provider = getBundledProviders().find((row) => row.id === providerId);
  const target = provider
    ? aiProviderSheetTarget({
        provider,
        connections: [],
        connectionId: undefined,
        pathname: `/connections/${providerId}`,
      })
    : null;
  if (!target) throw new Error("Missing AI provider sheet target");
  const onConnected = vi.fn();
  const onFlash = vi.fn();
  const onClose = vi.fn();
  render(
    <AiProviderSheet
      target={target}
      onConnected={onConnected}
      onFlash={onFlash}
      onClose={onClose}
    />,
  );
  return { fixture, onConnected, onFlash, onClose };
}
async function enterModel() {
  await userEvent.type(screen.getByLabelText("Model ID"), "fixture-model");
  await userEvent.type(screen.getByLabelText("API key"), SECRET);
}

it("composes the shared configuration with a partner endpoint, protocol and editable model", () => {
  mount();
  expect(
    screen.getByRole("dialog", { name: "Connect a model provider" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "xAI",
  );
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "https://api.x.ai/v1",
  );
  expect(screen.getByLabelText("API family")).toHaveProperty(
    "value",
    "openai_chat",
  );
  expect(
    screen.getByRole("button", { name: "Save AI connection" }),
  ).toHaveProperty("disabled", true);
});

it("resets the draft and credential when the selected provider changes", async () => {
  connectorIntegration();
  const onConnected = vi.fn();
  const onFlash = vi.fn();
  const onClose = vi.fn();
  const target = (providerId: string) => {
    const selected = aiProviderSheetTarget({
      provider:
        getBundledProviders().find((row) => row.id === providerId) ?? null,
      connections: [],
      connectionId: undefined,
      pathname: `/connections/${providerId}`,
    });
    if (!selected) throw new Error(`Missing AI provider sheet: ${providerId}`);
    return selected;
  };
  const { rerender } = render(
    <AiProviderSheet
      target={target("openai")}
      onConnected={onConnected}
      onFlash={onFlash}
      onClose={onClose}
    />,
  );
  await userEvent.type(screen.getByLabelText("API key"), SECRET);
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "OpenAI",
  );
  rerender(
    <AiProviderSheet
      target={target("openrouter")}
      onConnected={onConnected}
      onFlash={onFlash}
      onClose={onClose}
    />,
  );
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "OpenRouter",
  );
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "https://openrouter.ai/api/v1",
  );
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  expect(readDeviceRows()).toHaveLength(0);
  expect(onConnected).not.toHaveBeenCalled();
});

it("tests inference against the configured serving endpoint without saving", async () => {
  const probe = vi
    .spyOn(aiConnectionUiDependencies, "test")
    .mockResolvedValue("Model inference verified");
  const { onConnected } = mount("huggingface");
  await enterModel();
  await userEvent.clear(screen.getByLabelText("API base URL"));
  await userEvent.type(
    screen.getByLabelText("API base URL"),
    "https://models.example/custom/v1",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Test AI connection" }),
  );
  await waitFor(() =>
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "huggingface",
        baseUrl: "https://models.example/custom/v1",
        model: "fixture-model",
        apiKey: SECRET,
      }),
      undefined,
      undefined,
      expect.objectContaining({
        prediction: expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      }),
    ),
  );
  expect(readDeviceRows()).toHaveLength(0);
  expect(onConnected).not.toHaveBeenCalled();
  expect(await screen.findByLabelText("Model inference verified")).toBeTruthy();
});

it("commits through the common service and clears the write-only input before notifying the route", async () => {
  const save = vi
    .spyOn(aiConnectionUiDependencies, "save")
    .mockImplementation((draft) =>
      commitAiConnection(draft, "fixture-vault", "", vi.fn()),
    );
  const { onConnected } = mount();
  await enterModel();
  await userEvent.click(
    screen.getByRole("button", { name: "Save AI connection" }),
  );
  await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  expect(JSON.stringify(readDeviceRows())).not.toContain(SECRET);
});

it("keeps the draft on failure and redacts credential reflections from notices", async () => {
  vi.spyOn(aiConnectionUiDependencies, "test").mockRejectedValue(
    new Error(`Refused ${SECRET}`),
  );
  const { onFlash, onConnected } = mount();
  await enterModel();
  await userEvent.click(
    screen.getByRole("button", { name: "Test AI connection" }),
  );
  await waitFor(() => expect(onFlash).toHaveBeenCalledOnce());
  expect(JSON.stringify(onFlash.mock.calls)).not.toContain(SECRET);
  expect(document.body.textContent).not.toContain(SECRET);
  expect(screen.getByLabelText("API key")).toHaveProperty("value", SECRET);
  expect(onConnected).not.toHaveBeenCalled();
  expect(readDeviceRows()).toHaveLength(0);
});

it("preserves attended keyboard dismissal and sends nothing on mount", async () => {
  const probe = vi.spyOn(aiConnectionUiDependencies, "test");
  const { onClose } = mount();
  expect(document.activeElement).toBe(screen.getByLabelText("API key"));
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  expect(probe).not.toHaveBeenCalled();
});
