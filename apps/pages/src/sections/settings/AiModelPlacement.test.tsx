/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { loadModelProvider } from "@opensesame/app-core/lib/model-provider.js";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { createTestContext } from "../../modules/test-context.js";
import {
  installPanelFixture,
  openConnectorPages,
  renderIntegrationsPanel,
  renderPanel,
} from "./settings-panels.test-support.js";

installDoublePorts();
installPanelFixture();

const disposals: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function installModelPanel() {
  const { capabilityRuntime } = await import(
    "../../modules/support.local-ai/runtime.js"
  );
  const context = createTestContext();
  const handle = await capabilityRuntime.activate(context.ctx);
  disposals.push(() => handle.dispose());
  for (const panel of context.entries("settings-panel"))
    disposals.push(registerContributionForTest("settings-panel", panel));
}

it("composes voice and inference choices into Features AI and saves a model choice there", async () => {
  await installModelPanel();
  const { container } = renderPanel();
  const inference = await screen.findByLabelText("Inference model");
  expect(inference.closest("#feature-ai")).not.toBeNull();
  expect(
    screen.getByLabelText("Voice model").closest("#feature-ai"),
  ).not.toBeNull();
  expect(
    container.querySelectorAll(
      '[data-guide-targets~="settings.model-provider"]',
    ),
  ).toHaveLength(1);
  await userEvent.selectOptions(inference, "ollama/llama3.2");
  await waitFor(() => {
    expect(screen.getByRole("img", { name: "Saved." })).toBeTruthy();
    expect(loadModelProvider().inference).toMatchObject({
      provider: "ollama",
      model: "llama3.2",
      kind: "local",
    });
  });
  cleanup();
  openConnectorPages();
  renderIntegrationsPanel();
  expect(screen.queryByLabelText("Voice model")).toBeNull();
  expect(screen.queryByLabelText("Inference model")).toBeNull();
  expect(
    screen.getAllByRole("list", { name: "AI providers" }).length,
  ).toBeGreaterThan(0);
});

it("does not mount model configuration before the AI capability contributes it", () => {
  renderPanel();
  expect(screen.queryByLabelText("Voice model")).toBeNull();
  expect(screen.queryByLabelText("Inference model")).toBeNull();
});
