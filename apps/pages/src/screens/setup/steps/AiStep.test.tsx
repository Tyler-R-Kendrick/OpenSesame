import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserInferenceSeams } from "../../../lib/browser-inference.js";
import {
  resetSpeechSeams,
  speechSeams,
} from "../../../lib/command-bar/speech.js";
import { kvSetDurable } from "../../../lib/kv.js";
import {
  MODEL_PROVIDER_KEY,
  loadModelProvider,
} from "../../../lib/model-provider.js";
import { modelSlugSeams } from "../../../lib/model-slugs.js";
import { AiStep } from "./AiStep.js";

const originalSeams = { ...browserInferenceSeams };
const originalList = modelSlugSeams.listConnections;

function capableBrowser() {
  browserInferenceSeams.isSecureContext = () => true;
  browserInferenceSeams.languageModel = () => ({
    availability: async () => "available",
  });
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
  capableBrowser();
  modelSlugSeams.listConnections = async () => [];
});

afterEach(() => {
  cleanup();
  Object.assign(browserInferenceSeams, originalSeams);
  modelSlugSeams.listConnections = originalList;
  resetSpeechSeams();
  vi.restoreAllMocks();
});

describe("AiStep", () => {
  it("offers voice and inference slug selects", async () => {
    render(<AiStep />);

    expect(await screen.findByLabelText("Voice model")).toBeTruthy();
    expect(screen.getByLabelText("Inference model")).toBeTruthy();
  });

  it("persists a speech language and an inference slug", async () => {
    render(<AiStep />);

    await userEvent.selectOptions(
      await screen.findByLabelText("Voice model"),
      "browser-speech/de-DE",
    );
    await waitFor(() => {
      expect(loadModelProvider().voice.model).toBe("de-DE");
    });

    await userEvent.selectOptions(
      screen.getByLabelText("Inference model"),
      "ollama/qwen2.5-vl:7b",
    );
    await waitFor(() => {
      expect(loadModelProvider().inference.provider).toBe("ollama");
      expect(loadModelProvider().provider).toBe("ollama");
    });
  });

  it("withholds browser inference when the device cannot carry one", async () => {
    browserInferenceSeams.languageModel = () => null;
    browserInferenceSeams.gpu = () => null;
    render(<AiStep />);

    const inference = await screen.findByLabelText("Inference model");
    expect(
      Array.from(inference.querySelectorAll("option")).some(
        (option) => option.value === "browser/",
      ),
    ).toBe(false);
  });
});
