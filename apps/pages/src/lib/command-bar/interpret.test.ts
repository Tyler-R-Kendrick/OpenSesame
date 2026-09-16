import { afterEach, describe, expect, it } from "vitest";
import { loadModelProvider } from "../model-provider.js";
import { interpretCommand, interpretSeams } from "./interpret.js";

describe("interpretCommand", () => {
  afterEach(() => {
    interpretSeams.generateObject = null;
    interpretSeams.loadModelProvider = loadModelProvider;
  });

  it("prefers the deterministic parser over the model", async () => {
    let called = false;
    interpretSeams.generateObject = async () => {
      called = true;
      throw new Error("model should not run");
    };

    const result = await interpretCommand("go to vault");
    expect(result).toEqual({
      source: "parse",
      command: { action: "navigate", path: "/vault" },
    });
    expect(called).toBe(false);
  });

  it("refuses empty input without calling the model", async () => {
    const result = await interpretCommand("   ");
    expect(result.source).toBe("none");
  });

  it("skips the Prompt API when inference is a local provider", async () => {
    let called = false;
    interpretSeams.generateObject = async () => {
      called = true;
      throw new Error("model should not run");
    };
    interpretSeams.loadModelProvider = () => ({
      kind: "local",
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen2.5-vl:7b",
      voice: {
        provider: "browser-speech",
        kind: "browser",
        endpoint: "",
        model: "en-US",
      },
      inference: {
        kind: "local",
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "qwen2.5-vl:7b",
      },
    });

    const result = await interpretCommand("please open my vault please");
    expect(result.source).toBe("none");
    if (result.source === "none") {
      expect(result.reason).toMatch(/Settings › AI models/);
    }
    expect(called).toBe(false);
  });
});
