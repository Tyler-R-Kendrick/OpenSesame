import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserInferenceSeams } from "../../lib/browser-inference.js";
import { kvSetDurable } from "../../lib/kv.js";
import {
  MODEL_PROVIDER_KEY,
  loadModelProvider,
} from "../../lib/model-provider.js";
import { ModelProviderPanel } from "./ModelProviderPanel.js";

const originalSeams = { ...browserInferenceSeams };

/** A browser whose own model is resident and can be shown a page. */
function capableBrowser() {
  browserInferenceSeams.isSecureContext = () => true;
  browserInferenceSeams.languageModel = () => ({
    availability: async () => "available",
  });
  browserInferenceSeams.gpu = () => null;
}

/** A browser with a text-only model and graphics that could run one in-page. */
function textOnlyBrowser() {
  browserInferenceSeams.isSecureContext = () => true;
  browserInferenceSeams.languageModel = () => ({
    availability: async (options?: {
      expectedInputs?: readonly { readonly type: string }[];
    }) => (options === undefined ? "available" : "unavailable"),
  });
  browserInferenceSeams.gpu = () => ({ requestAdapter: async () => ({}) });
}

/** A browser that carries nothing. */
function barrenBrowser() {
  browserInferenceSeams.isSecureContext = () => true;
  browserInferenceSeams.languageModel = () => null;
  browserInferenceSeams.gpu = () => null;
}

beforeEach(async () => {
  await kvSetDurable(MODEL_PROVIDER_KEY, "");
});

afterEach(() => {
  cleanup();
  Object.assign(browserInferenceSeams, originalSeams);
  vi.restoreAllMocks();
});

describe("ModelProviderPanel", () => {
  it("reports the browser fallback when nothing is configured", async () => {
    capableBrowser();
    render(<ModelProviderPanel />);

    expect(
      await screen.findByText(/No provider set, so this device's own model/),
    ).toBeTruthy();
  });

  it("withholds the browser option rather than greying it, and says why", async () => {
    barrenBrowser();
    render(<ModelProviderPanel />);

    expect(
      await screen.findByText(/neither an on-device model nor the graphics/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Use this device's own model/ }),
    ).toBeNull();
  });

  it("distinguishes a text-only model from no model, and never offers a silent download", async () => {
    textOnlyBrowser();
    render(<ModelProviderPanel />);

    expect(
      await screen.findByText(/reads text but cannot be shown a page/),
    ).toBeTruthy();
    // The WebGPU rung is described with its cost, not offered as a tap.
    expect(screen.getByText(/somebody has to send the weights/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Use this device's own model/ }),
    ).toBeNull();
  });

  it("says password changes stay manual where nothing can run", async () => {
    barrenBrowser();
    render(<ModelProviderPanel />);

    expect(await screen.findByText(/it never half-tries/)).toBeTruthy();
  });

  it("records the browser plane with no endpoint", async () => {
    capableBrowser();
    render(<ModelProviderPanel />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use this device's own model",
      }),
    );

    await waitFor(() => {
      expect(loadModelProvider()).toEqual({
        kind: "browser",
        provider: "browser",
        endpoint: "",
        model: "",
      });
    });
  });

  it("prefers a named provider over the device that could have carried it", async () => {
    capableBrowser();
    render(<ModelProviderPanel />);

    const rows = await screen.findAllByRole("button", { name: "Use" });
    await userEvent.click(rows[0]);

    await waitFor(() => {
      expect(loadModelProvider().provider).toBe("ollama");
    });
    expect(await screen.findByText(/Running on this machine/)).toBeTruthy();
  });

  it("asks for an address and never for a key", async () => {
    capableBrowser();
    const { container } = render(<ModelProviderPanel />);

    const rows = await screen.findAllByRole("button", { name: "Use" });
    await userEvent.click(rows[0]);

    expect(await screen.findByText("Endpoint")).toBeTruthy();
    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.getByText(/An API key is not asked for here/)).toBeTruthy();
    // No field a key could be typed into at all — not a masked one, not a
    // plain one. The panel stores addresses; the key lives in the vault.
    expect(container.querySelectorAll("input[type=password]").length).toBe(0);
    expect(
      [...container.querySelectorAll("input")]
        .map((input) => input.type)
        .sort(),
    ).toEqual(["text", "url"]);
  });

  it("returns to the fallback when the provider is cleared", async () => {
    capableBrowser();
    render(<ModelProviderPanel />);

    const rows = await screen.findAllByRole("button", { name: "Use" });
    await userEvent.click(rows[0]);

    await userEvent.click(
      await screen.findByRole("button", { name: "Use no provider" }),
    );

    expect(
      await screen.findByText(/No provider set, so this device's own model/),
    ).toBeTruthy();
  });
});
