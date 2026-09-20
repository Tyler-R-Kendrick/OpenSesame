import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserInferenceSeams } from "../../lib/browser-inference.js";
import { resetSpeechSeams, speechSeams } from "../../lib/command-bar/speech.js";
import { kvSetDurable } from "../../lib/kv.js";
import {
  MODEL_PROVIDER_KEY,
  loadModelProvider,
} from "../../lib/model-provider.js";
import { modelSlugSeams } from "../../lib/model-slugs.js";
import { ModelProviderPanel } from "./ModelProviderPanel.js";

const originalSeams = { ...browserInferenceSeams };
const originalList = modelSlugSeams.listConnections;

/** A browser whose own model is resident and can be shown a page. */
function capableBrowser() {
  browserInferenceSeams.isSecureContext = () => true;
  browserInferenceSeams.languageModel = () => ({
    availability: async () => "available",
  });
  browserInferenceSeams.gpu = () => null;
}

/** A browser that carries nothing. */
function barrenBrowser() {
  browserInferenceSeams.isSecureContext = () => true;
  browserInferenceSeams.languageModel = () => null;
  browserInferenceSeams.gpu = () => null;
}

function speechAvailable() {
  speechSeams.globals = () => ({
    SpeechRecognition: class {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop() {}
      abort() {}
    },
  });
}

beforeEach(async () => {
  await kvSetDurable(MODEL_PROVIDER_KEY, "");
  speechAvailable();
  modelSlugSeams.listConnections = async () => [];
});

afterEach(() => {
  cleanup();
  Object.assign(browserInferenceSeams, originalSeams);
  modelSlugSeams.listConnections = originalList;
  resetSpeechSeams();
  vi.restoreAllMocks();
});

describe("ModelProviderPanel", () => {
  it("offers one voice select and one inference select", async () => {
    capableBrowser();
    render(<ModelProviderPanel />);

    expect(
      await screen.findByRole("heading", { name: /^Models/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Voice model")).toBeTruthy();
    expect(screen.getByLabelText("Inference model")).toBeTruthy();
  });

  it("records a browser-speech language slug", async () => {
    capableBrowser();
    render(<ModelProviderPanel />);

    await userEvent.selectOptions(
      await screen.findByLabelText("Voice model"),
      "browser-speech/ja-JP",
    );

    await waitFor(() => {
      expect(loadModelProvider().voice).toEqual({
        provider: "browser-speech",
        kind: "browser",
        endpoint: "",
        model: "ja-JP",
      });
    });
  });

  it("records a local inference slug without a harness connection", async () => {
    barrenBrowser();
    render(<ModelProviderPanel />);

    await userEvent.selectOptions(
      await screen.findByLabelText("Inference model"),
      "ollama/llama3.2",
    );

    await waitFor(() => {
      expect(loadModelProvider().inference.provider).toBe("ollama");
      expect(loadModelProvider().inference.model).toBe("llama3.2");
      expect(loadModelProvider().provider).toBe("ollama");
      expect(loadModelProvider().kind).toBe("local");
    });
  });

  it("offers hosted harness slugs only after that provider is connected", async () => {
    barrenBrowser();
    modelSlugSeams.listConnections = async () => [
      {
        connectionId: "c_openai",
        connectionRef: "ref",
        logicalName: "openai",
        displayName: "OpenAI",
        providerId: "openai",
        integrationId: null,
        status: "active",
        statusDetail: null,
        organizationId: "org",
        projectId: null,
        ownerKind: "user",
        shareability: "private",
        requestedScopes: [],
        grantedScopes: [],
        accountLabel: null,
        expiresAt: null,
        refreshable: false,
        lastRefreshedAt: null,
        maxInvokeLevel: 0,
        egress: { scheme: "https", authorities: [], pathPrefixes: [] },
        bindings: [],
        createdAt: "",
        updatedAt: "",
      },
    ];
    render(<ModelProviderPanel />);

    const inference = await screen.findByLabelText("Inference model");
    expect(
      Array.from(inference.querySelectorAll("option")).some(
        (option) => option.value === "openai/gpt-4o",
      ),
    ).toBe(true);

    await userEvent.selectOptions(inference, "openai/gpt-4o");
    await waitFor(() => {
      expect(loadModelProvider().inference).toEqual({
        provider: "openai",
        kind: "hosted",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o",
      });
    });
  });

  it("withholds browser inference when the device cannot carry one", async () => {
    barrenBrowser();
    render(<ModelProviderPanel />);

    const inference = await screen.findByLabelText("Inference model");
    expect(
      Array.from(inference.querySelectorAll("option")).some(
        (option) => option.value === "browser/",
      ),
    ).toBe(false);
  });

  it("withholds the voice catalog when speech recognition is missing", async () => {
    capableBrowser();
    speechSeams.globals = () => ({});
    render(<ModelProviderPanel />);

    const voice =
      await screen.findByLabelText<HTMLSelectElement>("Voice model");
    expect(voice.disabled).toBe(true);
    expect(voice.querySelector("option")?.textContent).toBe("Unavailable");
  });
});
