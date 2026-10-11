/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { AiProviderSheet } from "./AiProviderSheet.js";
import { aiProviderSheetTarget } from "./ai-provider-sheet-target.js";

installConnectorIntegration();

const SECRET = "xai-private-key-0123456789";

function mount(onConnected = vi.fn(), providerId = "xai") {
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
  if (!target) throw new Error(`the ${providerId} sheet did not open`);
  const onFlash = vi.fn();
  const onClose = vi.fn();
  render(
    <AiProviderSheet
      target={target}
      onFlash={onFlash}
      onClose={onClose}
      onConnected={onConnected}
    />,
  );
  return { fixture, onFlash, onClose, onConnected };
}

const keyField = () =>
  screen.getByLabelText(/API key/i, { selector: 'input[type="password"]' });

function noSecretAnywhere(fixture: ReturnType<typeof connectorIntegration>) {
  expect(JSON.stringify(readDeviceRows())).not.toContain(SECRET);
  expect([...fixture.disk.files.values()].join()).not.toContain(SECRET);
}

it("offers a name and a key, and the host the key goes to", () => {
  mount();
  expect(screen.getByRole("dialog", { name: "Connect a model provider" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "xAI");
  expect(keyField()).toHaveProperty("value", "");
  expect(screen.getByText("api.x.ai")).toBeTruthy();
  expect(screen.getByText("OpenAI-compatible")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Save connection" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Test connection" }),
  ).toHaveProperty("disabled", true);
});

it("names the host a key is verified at, not the one models are served from", () => {
  // Hugging Face verifies a token at huggingface.co and serves from
  // router.huggingface.co: Test and Save send the pasted key to the first.
  mount(vi.fn(), "huggingface");
  expect(screen.getByText("huggingface.co")).toBeTruthy();
  expect(screen.queryByText("router.huggingface.co")).toBeNull();
});

it("tests a key against the provider and keeps nothing", async () => {
  const { fixture, onFlash, onConnected } = mount();
  fixture.replies.push({ body: { data: [] } });
  await userEvent.type(keyField(), SECRET);
  await userEvent.click(
    screen.getByRole("button", { name: "Test connection" }),
  );
  await waitFor(() => expect(fixture.requests).toHaveLength(1));
  expect(fixture.requests[0]?.url).toBe("https://api.x.ai/v1/models");
  expect(fixture.requests[0]?.method).toBe("GET");
  expect(fixture.requests[0]?.headers.get("authorization")).toBe(
    `Bearer ${SECRET}`,
  );
  await waitFor(() =>
    expect(screen.getByLabelText(/access verified/i)).toBeTruthy(),
  );
  expect(readDeviceRows()).toHaveLength(0);
  noSecretAnywhere(fixture);
  expect(onConnected).not.toHaveBeenCalled();
  expect(onFlash).not.toHaveBeenCalled();
});

it("saves a key only after the provider has accepted it, under the name given", async () => {
  const onConnected = vi.fn();
  const { fixture, onFlash } = mount(onConnected);
  fixture.replies.push({ body: { data: [] } });
  await userEvent.clear(screen.getByLabelText("Name"));
  await userEvent.type(screen.getByLabelText("Name"), "xAI for agents");
  await userEvent.type(keyField(), SECRET);
  await userEvent.click(
    screen.getByRole("button", { name: "Save connection" }),
  );
  await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing saved connector");
  const saved = readNativeConnector(row.connectionId);
  expect(saved?.status).toBe("connected");
  expect(saved?.providerId).toBe("xai");
  expect(saved?.configuration.displayName).toBe("xAI for agents");
  expect(fixture.requests).toHaveLength(1);
  // what it says is the landing page's to show: not raised on the sheet's own
  expect(onConnected).toHaveBeenCalledWith({
    tone: "ok",
    text: "xAI access verified and saved on this device.",
  });
  expect(onFlash).not.toHaveBeenCalled();
  noSecretAnywhere(fixture);
});

it("saves nothing, and says nothing of the key, when the provider refuses it", async () => {
  const { fixture, onFlash, onConnected } = mount();
  fixture.route.respond = async () =>
    Response.json({ error: `bad key ${SECRET}` }, { status: 401 });
  await userEvent.type(keyField(), SECRET);
  await userEvent.click(
    screen.getByRole("button", { name: "Save connection" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    ),
  );
  expect(readDeviceRows()).toHaveLength(0);
  expect(onConnected).not.toHaveBeenCalled();
  for (const call of onFlash.mock.calls)
    expect(JSON.stringify(call)).not.toContain(SECRET);
  // what the page says about the failure, to a reader or a screen reader
  const said = [
    document.body.textContent ?? "",
    ...[...document.querySelectorAll("[aria-label],[title]")].map(
      (element) =>
        `${element.getAttribute("aria-label")} ${element.getAttribute("title")}`,
    ),
  ].join(" ");
  expect(said).not.toContain(SECRET);
  noSecretAnywhere(fixture);
});

it("reports a refused test as a failure and leaves the key to be corrected", async () => {
  const { fixture, onFlash } = mount();
  fixture.route.respond = async () => Response.json({}, { status: 401 });
  await userEvent.type(keyField(), SECRET);
  await userEvent.click(
    screen.getByRole("button", { name: "Test connection" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    ),
  );
  expect(readDeviceRows()).toHaveLength(0);
  // editing the key clears the verdict on the old one
  await userEvent.type(keyField(), "x");
  expect(screen.queryByLabelText(/access verified/i)).toBeNull();
});

it("leaves the field on the first Escape, closes on the second, and sends nothing on its own", async () => {
  const { fixture, onClose } = mount();
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(fixture.requests).toHaveLength(0);
});

it("puts the keyboard on the key, where a key is what the person came to paste", () => {
  mount();
  expect(document.activeElement).toBe(keyField());
});

describe("on a touch screen", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    // jsdom has no matchMedia; the sheet reads only `matches`.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("pointer: coarse"),
      }),
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: original,
    });
  });

  it("leaves the keyboard down and lands on the Close key, never behind the scrim", () => {
    mount();
    const close = document.querySelector(".sheet__head .icon-btn");
    expect(close).toBeTruthy();
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(keyField());
  });
});
