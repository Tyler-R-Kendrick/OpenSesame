/** @vitest-environment jsdom */

/**
 * A gate's engine asks no agent for anything (ADR 0166): nothing can answer
 * from a model and nothing can leave the device, whatever capabilities the
 * installation has approved.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installSupportAgentLoaders,
  resetSupportAgentLoadersForTest,
} from "./agent-seams.js";
import { loadBrowserEngine } from "./engine.js";

const host = {
  navigate: () => {},
  currentRoute: () => "/unlock/door",
  observeRoute: () => Promise.resolve(),
};

afterEach(() => {
  resetSupportAgentLoadersForTest();
});

function spies() {
  const created = vi.fn(() => null);
  const acquired = vi.fn(() => Promise.resolve());
  const released = vi.fn();
  const promptApi = vi.fn(() =>
    Promise.resolve({
      createPromptApiAgent: created,
      acquirePromptApiModel: acquired,
      releaseLocalModelSession: released,
    }),
  );
  const provider = vi.fn(() =>
    Promise.resolve({ createProviderAgent: () => null }),
  );
  const agUi = vi.fn(() => Promise.resolve({ createAgUiAgent: () => null }));
  installSupportAgentLoaders({ promptApi, provider, agUi });
  return { promptApi, provider, agUi, created };
}

describe("the offline engine a gate is built with", () => {
  it("asks no agent loader for anything, and answers from nowhere", async () => {
    const seen = spies();
    const engine = await loadBrowserEngine(host, { offline: true });
    expect(seen.promptApi).not.toHaveBeenCalled();
    expect(seen.provider).not.toHaveBeenCalled();
    expect(seen.agUi).not.toHaveBeenCalled();
    expect(engine.transport).toBe("none");
    expect(engine.warning).toBeNull();
    expect(await engine.session.availability()).toEqual({
      kind: "unavailable",
      reason: "no_local_model",
    });
    engine.destroy();
  });

  it("is still the engine that compiles and runs an authored tour", async () => {
    spies();
    const engine = await loadBrowserEngine(host, { offline: true });
    const program = engine.compileAuthored(
      [
        "guide/1",
        'goal "gate.front-door"',
        'say "Nothing here asks who you are."',
        "end",
      ].join("\n"),
    );
    expect(program).not.toBeNull();
    engine.destroy();
  });

  it("is the shell's engine when it is not offline: the loaders are asked", async () => {
    const seen = spies();
    const engine = await loadBrowserEngine(host);
    expect(seen.promptApi).toHaveBeenCalled();
    expect(seen.provider).toHaveBeenCalled();
    engine.destroy();
  });
});
