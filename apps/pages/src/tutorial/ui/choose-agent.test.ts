/** @vitest-environment jsdom */

/**
 * Which agent answers — and therefore whether a question leaves the device.
 *
 * Split out of `support.test.tsx`, which drives the panel; this is a pure
 * choice over what the device already has, with no panel to open. The
 * decision is security-relevant on its own: these assertions are the only
 * thing standing between a person and their questions being sent to an
 * endpoint they did not choose.
 */

import {
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
} from "@opensesame/support-agent";
import { describe, expect, it } from "vitest";
import { chooseSupportAgent } from "../choose-agent.js";

describe("choosing what answers", () => {
  const absent = fakeAgentAlwaysUnavailable("no_local_model");

  it("keeps a question on the device whenever the device can answer", () => {
    const local = fakeAgentAnswering("local");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "ready" },
      null,
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(local);
    // A downloading model is still a model; the endpoint does not win here.
    expect(
      chooseSupportAgent(
        local,
        { kind: "downloading", progress: 0.2 },
        null,
        () => remote,
        absent,
      ).transport,
    ).toBe("on-device");
  });

  /**
   * Pinned because it looks like a bug and is not. A browser that exposes the
   * Prompt API without the model downloaded reports `downloadable`, and this
   * still chooses the device: the panel says the model has not been fetched and
   * offers the download as a click. Preferring the endpoint would send somebody
   * questions off their device because of a download nobody asked them about,
   * which is the opposite of what on-device-by-default is for.
   */
  it("still prefers the device when its model has not been downloaded yet", () => {
    const local = fakeAgentAnswering("local");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "downloadable" },
      null,
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(local);
    expect(remote.destroyed()).toBe(false);
  });

  it("uses a configured local provider before a pending browser download", () => {
    const local = fakeAgentAnswering("browser");
    const provider = fakeAgentAnswering("ollama");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "downloadable" },
      provider,
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(provider);
  });

  it("falls back to a configured endpoint only when the device cannot", () => {
    const local = fakeAgentAnswering("local");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "unavailable", reason: "platform_unsupported" },
      null,
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("remote");
    expect(choice.port).toBe(remote);
    // The unused provider session is dropped rather than left holding context.
    expect(local.destroyed()).toBe(true);
  });

  it("keeps the local reason when there is no endpoint to fall back to", () => {
    const local = fakeAgentAlwaysUnavailable("model_not_downloaded");
    const choice = chooseSupportAgent(
      local,
      { kind: "unavailable", reason: "model_not_downloaded" },
      null,
      () => null,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(local);
  });

  it("still answers with something when the browser has neither", () => {
    const choice = chooseSupportAgent(null, null, null, () => null, absent);
    expect(choice.transport).toBe("none");
    expect(choice.port).toBe(absent);
  });
});
