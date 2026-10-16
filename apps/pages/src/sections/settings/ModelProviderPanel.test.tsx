import { browserInferenceSeams } from "@opensesame/app-core/lib/browser-inference.js";
import {
  resetSpeechSeams,
  speechSeams,
} from "@opensesame/app-core/lib/command-bar/speech.js";
import {
  type HostedModelConnection,
  bindHostedModelAuthority,
} from "@opensesame/app-core/lib/hosted-model-authority.js";
import { kvSetDurable } from "@opensesame/app-core/lib/kv.js";
import { notifyModelKeys } from "@opensesame/app-core/lib/model-keys/active.js";
import {
  MODEL_PROVIDER_KEY,
  loadModelProvider,
  modelProviderSeams,
} from "@opensesame/app-core/lib/model-provider.js";
import { modelSlugSeams } from "@opensesame/app-core/lib/model-slugs.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
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

  it("describes a stored hosted model as selected rather than already running", async () => {
    barrenBrowser();
    await kvSetDurable(
      MODEL_PROVIDER_KEY,
      JSON.stringify({
        kind: "hosted",
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o",
      }),
    );
    render(<ModelProviderPanel />);
    expect(
      await screen.findByRole("img", {
        name: "Hosted model selected. Answers require a verified connector and active Remote AI support and External connectors capabilities.",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Running at the provider/)).toBeNull();
  });

  it("restores the saved native selection when its credential authority becomes ready", async () => {
    barrenBrowser();
    const connection: HostedModelConnection = {
      connectionId: "native-ai-saved",
      providerId: "byo-ai",
      status: "connected",
      method: "api-key",
      model: "custom-chat",
      endpoint: "https://models.example/custom/v1",
      name: "Private chat",
    };
    let available: HostedModelConnection[] = [];
    const release = bindHostedModelAuthority({
      assertCurrent: () => {},
      fetch,
      read: (id) => available.find((row) => row.connectionId === id) ?? null,
      connections: () => available,
      execute: async () => null,
    });
    const inference = {
      kind: "hosted",
      provider: connection.providerId,
      endpoint: connection.endpoint,
      model: connection.model,
      connectionId: connection.connectionId,
    };
    try {
      await kvSetDurable(
        MODEL_PROVIDER_KEY,
        JSON.stringify({ ...inference, inference }),
      );
      render(<ModelProviderPanel />);
      // Wait for the initial option discovery to finish before authority becomes ready.
      await screen.findByRole("img", {
        name: "Hosted model selected. Answers require a verified connector and active Remote AI support and External connectors capabilities.",
      });
      await waitFor(() => {
        expect(screen.getByLabelText("Inference model")).toHaveProperty(
          "value",
          "",
        );
      });
      act(() => {
        available = [connection];
        notifyModelKeys();
      });
      await waitFor(() => {
        expect(screen.getByLabelText("Inference model")).toHaveProperty(
          "value",
          "connection:native-ai-saved",
        );
      });
      expect(loadModelProvider().inference).toEqual(inference);
    } finally {
      release();
    }
  });
  it("sends a failed save to the tray", async () => {
    barrenBrowser();
    const save = modelProviderSeams.saveModelProvider;
    modelProviderSeams.saveModelProvider = async () => {
      throw new Error("disk full");
    };
    try {
      render(<ModelProviderPanel />);
      await userEvent.selectOptions(
        await screen.findByLabelText("Inference model"),
        "ollama/llama3.2",
      );
      await expectInTray("Could not save this choice on this device.");
    } finally {
      modelProviderSeams.saveModelProvider = save;
    }
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
