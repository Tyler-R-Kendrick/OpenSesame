import { afterEach, expect, it, vi } from "vitest";
import {
  installSupportAgentLoaders,
  resetSupportAgentLoadersForTest,
} from "./agent-seams.js";
import { lazyEngineAgent } from "./lazy-engine-agent.js";

function deferred<T>() {
  let finish: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
afterEach(resetSupportAgentLoadersForTest);

it("destroys provisional ports while local availability is still pending", async () => {
  const available = deferred<{ kind: "ready" }>();
  const local = {
    availability: vi.fn(() => available.promise),
    run: vi.fn(),
    destroy: vi.fn(),
  };
  const provider = { availability: vi.fn(), run: vi.fn(), destroy: vi.fn() };
  const released = vi.fn();
  installSupportAgentLoaders({
    promptApi: () =>
      Promise.resolve({
        createPromptApiAgent: () => local,
        acquirePromptApiModel: () => Promise.resolve(),
        releaseLocalModelSession: released,
      }),
    provider: () => Promise.resolve({ createProviderAgent: () => provider }),
  });
  const agent = lazyEngineAgent(false);
  const reading = agent.port.availability();
  const rejected = expect(reading).rejects.toMatchObject({
    code: "AGENT_ABORTED",
  });
  await vi.waitFor(() => expect(local.availability).toHaveBeenCalledTimes(1));
  agent.port.destroy();
  expect(local.destroy).toHaveBeenCalledTimes(1);
  expect(provider.destroy).toHaveBeenCalledTimes(1);
  expect(agent.transport).toBe("none");
  available.finish({ kind: "ready" });
  await rejected;
  expect(local.destroy).toHaveBeenCalledTimes(1);
  expect(provider.destroy).toHaveBeenCalledTimes(1);
  expect(released).toHaveBeenCalled();
});

it("releases a model acquisition completing after destruction and refuses reuse", async () => {
  const download = deferred<void>();
  const acquire = vi.fn(() => download.promise);
  const release = vi.fn();
  installSupportAgentLoaders({
    promptApi: () =>
      Promise.resolve({
        createPromptApiAgent: () => null,
        acquirePromptApiModel: acquire,
        releaseLocalModelSession: release,
      }),
  });
  const agent = lazyEngineAgent(false);
  const acquiring = agent.acquire(() => {});
  const rejected = expect(acquiring).rejects.toMatchObject({
    code: "AGENT_ABORTED",
  });
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
  agent.port.destroy();
  expect(release).toHaveBeenCalledTimes(1);
  download.finish();
  await rejected;
  expect(release).toHaveBeenCalledTimes(2);
  await expect(agent.port.availability()).rejects.toMatchObject({
    code: "AGENT_ABORTED",
  });
  expect(agent.transport).toBe("none");
});

it("refuses a stale selection after acquisition has selected a fresh model port", async () => {
  const oldReady = deferred<{ kind: "ready" }>();
  const old = {
    availability: vi.fn(() => oldReady.promise),
    run: vi.fn(),
    destroy: vi.fn(),
  };
  const fresh = {
    availability: vi.fn(() => Promise.resolve({ kind: "ready" as const })),
    run: vi.fn(),
    destroy: vi.fn(),
  };
  const create = vi.fn().mockReturnValueOnce(old).mockReturnValue(fresh);
  installSupportAgentLoaders({
    promptApi: () =>
      Promise.resolve({
        createPromptApiAgent: create,
        acquirePromptApiModel: () => Promise.resolve(),
        releaseLocalModelSession: () => {},
      }),
  });
  const agent = lazyEngineAgent(false);
  const stale = agent.port.availability();
  const rejected = expect(stale).rejects.toMatchObject({
    code: "AGENT_ABORTED",
  });
  await vi.waitFor(() => expect(old.availability).toHaveBeenCalledTimes(1));
  await agent.acquire(() => {});
  expect(old.destroy).toHaveBeenCalledTimes(1);
  expect(await agent.port.availability()).toEqual({ kind: "ready" });
  oldReady.finish({ kind: "ready" });
  await rejected;
  expect(await agent.port.availability()).toEqual({ kind: "ready" });
  expect(old.availability).toHaveBeenCalledTimes(1);
  agent.port.destroy();
  expect(old.destroy).toHaveBeenCalledTimes(1);
  expect(fresh.destroy).toHaveBeenCalledTimes(1);
});

it("drops a provisional local port when provider construction fails and suppresses its error", async () => {
  const local = { availability: vi.fn(), run: vi.fn(), destroy: vi.fn() };
  installSupportAgentLoaders({
    promptApi: () =>
      Promise.resolve({
        createPromptApiAgent: () => local,
        acquirePromptApiModel: () => Promise.resolve(),
        releaseLocalModelSession: () => {},
      }),
    provider: () =>
      Promise.resolve({
        createProviderAgent: () => {
          throw new Error("PRIVATE_CONSTRUCTOR_SENTINEL");
        },
      }),
  });
  const agent = lazyEngineAgent(false);
  await expect(agent.port.availability()).rejects.toMatchObject({
    code: "AGENT_UNAVAILABLE",
    message: "Support agent is unavailable.",
  });
  expect(local.destroy).toHaveBeenCalledTimes(1);
  agent.port.destroy();
  expect(local.destroy).toHaveBeenCalledTimes(1);
});
