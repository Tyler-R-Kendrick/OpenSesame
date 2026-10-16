/** @vitest-environment jsdom */
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import * as aiRuntime from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { commitAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { expectInTray } from "../../../components/tray.test-support.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { AiInferenceWorkspace } from "./AiInferenceWorkspace.js";

installConnectorIntegration();

it("reports a model request failure in the tray and keeps the prompt available for retry", async () => {
  connectorIntegration();
  const connection = await commitAiConnection(
    {
      ...aiConnectionDraft("byo-ai"),
      model: "selected-model",
      baseUrl: "https://models.example/v1",
      authentication: "none",
    },
    "fixture-vault",
    "",
    vi.fn(),
  );
  const invoke = vi
    .spyOn(aiRuntime, "performSavedAiInference")
    .mockRejectedValueOnce(
      new Error("The model service is temporarily unavailable."),
    )
    .mockResolvedValueOnce({
      providerId: "byo-ai",
      model: "selected-model",
      answer: "Try again succeeded.",
    });
  render(<AiInferenceWorkspace connectionId={connection.connectionId} />);
  await userEvent.type(screen.getByLabelText("Prompt"), "Hello model");
  await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
  await expectInTray("The model service is temporarily unavailable.");
  expect(
    screen.getByRole("img", {
      name: "The model service is temporarily unavailable.",
    }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Prompt")).toHaveProperty(
    "value",
    "Hello model",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
  await waitFor(() => {
    expect(screen.getByLabelText("Model answer").textContent).toBe(
      "Try again succeeded.",
    );
    expect(
      screen.queryByRole("img", {
        name: "The model service is temporarily unavailable.",
      }),
    ).toBeNull();
  });
  expect(invoke).toHaveBeenLastCalledWith(
    connection.connectionId,
    expect.objectContaining({
      model: "selected-model",
      messages: [{ role: "user", content: "Hello model" }],
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    expect.any(Function),
  );
});
