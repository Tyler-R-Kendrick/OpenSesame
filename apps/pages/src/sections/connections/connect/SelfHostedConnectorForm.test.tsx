/** @vitest-environment jsdom */
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { kvForgetAll, kvSeams } from "@opensesame/app-core/lib/kv.js";
import {
  readSelfHostedConnector,
  saveSelfHostedConnector,
} from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SelfHostedConnectorForm } from "./SelfHostedConnectorForm.js";

const linear = connectPlan("linear");
if (!linear) throw new Error("Linear plan required");
const durableWrite = kvSeams.kvSetDurable;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  kvSeams.kvSetDurable = durableWrite;
  kvForgetAll();
});

it("keeps the entered credentials and reports failure when disk refuses the configuration", async () => {
  kvSeams.kvSetDurable = vi
    .fn()
    .mockRejectedValue(new Error("Storage unavailable"));
  const onFlash = vi.fn();
  const onSaved = vi.fn();
  render(
    <SelfHostedConnectorForm
      plan={linear}
      onFlash={onFlash}
      onSaved={onSaved}
    />,
  );
  await userEvent.type(
    screen.getByLabelText("Select a Linear workspace"),
    "workspace",
  );
  await userEvent.click(screen.getByText("Linear OAuth application"));
  await userEvent.type(screen.getByLabelText("Client ID"), "test-client");
  await userEvent.type(screen.getByLabelText("Client secret"), "test-secret");
  await userEvent.click(
    screen.getByRole("button", { name: "Create Connector" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith({
      tone: "err",
      text: "Storage unavailable",
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Client secret")).toHaveProperty(
      "value",
      "test-secret",
    ),
  );
  expect(onSaved).not.toHaveBeenCalled();
  expect(listDeviceConnections()).toHaveLength(0);
});

it("does not describe a stored API key as a saved OAuth application credential", async () => {
  const state = initialDraftState(linear, "api-key");
  const saved = await saveSelfHostedConnector(
    linear,
    { ...state, key: "test-key" },
    {
      mode: "byo",
      workspace: "workspace",
      appScopes: [],
      userScopes: [],
      webhookResourceTypes: [],
      icon: "",
    },
  );
  render(
    <SelfHostedConnectorForm
      plan={linear}
      connectorId={saved.connectionId}
      onFlash={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("radio", { name: "OAuth" }));
  expect(
    screen.queryByRole("img", { name: "Application credential saved" }),
  ).toBeNull();
  expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "");
});

async function fillApplication() {
  await userEvent.type(
    screen.getByLabelText("Select a Linear workspace"),
    "workspace",
  );
  await userEvent.click(screen.getByText("Linear OAuth application"));
  await userEvent.type(screen.getByLabelText("Client ID"), "test-client");
  await userEvent.type(screen.getByLabelText("Client secret"), "test-secret");
}

it("locks configuration fields until the save completes and rejects edits during storage", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  kvSeams.kvSetDurable = async (key, value) => {
    await pending;
    return durableWrite(key, value);
  };
  const onSaved = vi.fn();
  render(
    <SelfHostedConnectorForm
      plan={linear}
      onFlash={vi.fn()}
      onSaved={onSaved}
    />,
  );
  await fillApplication();
  const name = screen.getByLabelText("Connector Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Initial connector");
  await userEvent.click(
    screen.getByRole("button", { name: "Create Connector" }),
  );
  await waitFor(() => expect(name.matches(":disabled")).toBe(true));
  await userEvent.type(name, " Lost edit");
  await userEvent.click(screen.getByRole("radio", { name: "Bring Your Own" }));
  expect(name).toHaveProperty("value", "Initial connector");
  expect(screen.getByRole("radio", { name: "Managed" })).toHaveProperty(
    "checked",
    true,
  );
  expect(screen.getByLabelText("Client secret")).toHaveProperty(
    "value",
    "test-secret",
  );
  release();
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(name.matches(":disabled")).toBe(false);
  expect(listDeviceConnections()).toHaveLength(1);
  expect(
    readSelfHostedConnector(listDeviceConnections()[0]?.connectionId ?? "")
      ?.state.name,
  ).toBe("Initial connector");
});

it("waits for icon decoding before allowing submit, then includes the completed icon", async () => {
  let finishDecode = () => {};
  let decodeStarted = false;
  class PendingImage {
    naturalWidth = 640;
    naturalHeight = 640;
    onload: (() => void) | null = null;
    set src(_value: string) {
      decodeStarted = true;
      finishDecode = () => this.onload?.();
    }
  }
  vi.stubGlobal("Image", PendingImage);
  const write = vi.fn(durableWrite);
  kvSeams.kvSetDurable = write;
  const onSaved = vi.fn();
  render(
    <SelfHostedConnectorForm
      plan={linear}
      onFlash={vi.fn()}
      onSaved={onSaved}
    />,
  );
  await fillApplication();
  const icon = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    "icon.png",
    { type: "image/png" },
  );
  await userEvent.upload(screen.getByLabelText("Icon"), icon);
  const create = screen.getByRole("button", { name: "Create Connector" });
  await waitFor(() => expect(create).toHaveProperty("disabled", true));
  expect(screen.getByLabelText("Connector Name").matches(":disabled")).toBe(
    true,
  );
  const form = create.closest("form");
  if (!form) throw new Error("Connector form missing");
  fireEvent.submit(form);
  expect(write).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen
        .getByLabelText("Icon")
        .closest(".cx-icon-field")
        ?.getAttribute("aria-busy"),
    ).toBe("true"),
  );
  await waitFor(() => expect(decodeStarted).toBe(true));
  await act(async () => {
    finishDecode();
  });
  await waitFor(() => expect(create).toHaveProperty("disabled", false));
  await userEvent.click(create);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(
    readSelfHostedConnector(listDeviceConnections()[0]?.connectionId ?? "")
      ?.options.icon,
  ).toBe("data:image/png;base64,iVBORw0KGgo=");
});
