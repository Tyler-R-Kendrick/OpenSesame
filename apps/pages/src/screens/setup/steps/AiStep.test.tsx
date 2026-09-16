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
import { AiStep } from "./AiStep.js";

const originalSeams = { ...browserInferenceSeams };

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
});

afterEach(() => {
  cleanup();
  Object.assign(browserInferenceSeams, originalSeams);
  resetSpeechSeams();
  vi.restoreAllMocks();
});

describe("AiStep", () => {
  it("offers voice and inference catalog picks", async () => {
    render(<AiStep />);

    expect(await screen.findByRole("heading", { name: "Voice" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inference" })).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: /This device's own model/,
      }),
    ).toBeTruthy();
  });

  it("persists a speech language and an inference preset", async () => {
    render(<AiStep />);

    const lang = await screen.findByLabelText("Speech language");
    await userEvent.selectOptions(lang, "de-DE");
    await waitFor(() => {
      expect(loadModelProvider().voice.model).toBe("de-DE");
    });

    await userEvent.click(
      await screen.findByRole("button", { name: /Ollama/ }),
    );
    await waitFor(() => {
      expect(loadModelProvider().inference.provider).toBe("ollama");
      expect(loadModelProvider().provider).toBe("ollama");
    });
  });

  it("withholds the browser inference card when the device cannot carry one", async () => {
    browserInferenceSeams.languageModel = () => null;
    browserInferenceSeams.gpu = () => null;
    render(<AiStep />);

    expect(
      await screen.findByRole("heading", { name: "Inference" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /This device's own model/ }),
    ).toBeNull();
  });
});
