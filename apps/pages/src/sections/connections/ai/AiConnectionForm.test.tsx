/** @vitest-environment jsdom */
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AiConnectionForm } from "./AiConnectionForm.js";
afterEach(cleanup);

function mount(providerId: string, saved = false) {
  const draft = {
    ...aiConnectionDraft(providerId),
    baseUrl: "https://custom.example/v1",
    model: "custom-model",
    apiKey: saved ? "" : "private-ui-key",
  };
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

it("uses the common BYO form to expose four genuinely different API families", async () => {
  const state = mount("byo-ai");
  const options = within(screen.getByLabelText("API family")).getAllByRole(
    "option",
  );
  expect(options.map((option) => option.textContent)).toEqual([
    "OpenAI Chat Completions",
    "OpenAI Responses",
    "Anthropic Messages",
    "Gemini Generate Content",
  ]);
  await userEvent.selectOptions(
    screen.getByLabelText("API family"),
    "anthropic_messages",
  );
  expect(state.onChange).toHaveBeenCalledWith("family", "anthropic_messages");
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "https://custom.example/v1",
  );
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
