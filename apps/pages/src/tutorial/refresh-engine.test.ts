/** @vitest-environment jsdom */
import type { SupportAgentAvailability } from "@opensesame/support-agent";
import { afterEach, expect, it, vi } from "vitest";
import {
  installSupportAgentLoaders,
  resetSupportAgentLoadersForTest,
} from "./agent-seams.js";
import { loadBrowserEngine } from "./engine.js";
import { refreshEngineAvailability } from "./refresh-engine.js";

afterEach(resetSupportAgentLoadersForTest);

it("ignores a superseded availability read after a successful model acquisition", async () => {
  let ready: (state: SupportAgentAvailability) => void = () => {};
  const waiting = new Promise<SupportAgentAvailability>((resolve) => {
    ready = resolve;
  });
  const local = {
    availability: vi.fn(() => waiting),
    run: vi.fn(),
    destroy: vi.fn(),
  };
  installSupportAgentLoaders({
    promptApi: () =>
      Promise.resolve({
        createPromptApiAgent: () => local,
        acquirePromptApiModel: () => Promise.resolve(),
        releaseLocalModelSession: () => {},
      }),
  });
  const engine = await loadBrowserEngine({
    navigate: () => {},
    currentRoute: () => "/vault",
    observeRoute: () => Promise.resolve(),
  });
  const failed = vi.fn();
  const publish = vi.fn();
  const refreshing = refreshEngineAvailability(
    () => Promise.resolve(engine),
    () => engine,
    publish,
    failed,
  );
  await vi.waitFor(() => expect(local.availability).toHaveBeenCalledTimes(1));
  expect(await engine.acquire(() => {})).toEqual({ kind: "acquired" });
  ready({ kind: "ready" });
  await refreshing;
  expect(failed).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  engine.destroy();
});

it("reports a genuine loader failure without publishing its private details", async () => {
  installSupportAgentLoaders({
    promptApi: () => Promise.reject(new Error("PRIVATE_LOADER_SENTINEL")),
  });
  const engine = await loadBrowserEngine({
    navigate: () => {},
    currentRoute: () => "/vault",
    observeRoute: () => Promise.resolve(),
  });
  const failed = vi.fn();
  const publish = vi.fn();
  await refreshEngineAvailability(
    () => Promise.resolve(engine),
    () => engine,
    publish,
    failed,
  );
  expect(failed).toHaveBeenCalledExactlyOnceWith();
  expect(publish).not.toHaveBeenCalled();
  engine.destroy();
});
