/** @vitest-environment jsdom */

import {
  type BoundaryValue,
  type MutableBoundaryObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { detectLocalLanguageModel } from "./detect.js";

type FakeMonitorListener = (event: { loaded: BoundaryValue }) => void;

type FakeMonitor = {
  addEventListener: (type: string, listener: FakeMonitorListener) => void;
};

type FakePayload = {
  initialPrompts?: readonly { role: string; content: string }[];
  signal?: AbortSignal;
  monitor?: (monitor: FakeMonitor) => void;
};

type FakePlatform = {
  state: string;
  answer: BoundaryValue;
  emit: number[];
  payloads: FakePayload[];
  prompts: string[];
  destroys: number;
  availability: () => Promise<string>;
  create: (payload: FakePayload) => Promise<BoundaryValue>;
};

function createFakePlatform(): FakePlatform {
  const platform: FakePlatform = {
    state: "available",
    answer: "Answer.",
    emit: [],
    payloads: [],
    prompts: [],
    destroys: 0,
    // `this` is the platform object only when the detector pre-bound the
    // method the way the real interface object requires.
    availability(): Promise<string> {
      return Promise.resolve(this.state);
    },
    create(payload: FakePayload): Promise<BoundaryValue> {
      this.payloads.push(payload);
      const monitor = payload.monitor;
      if (monitor !== undefined) {
        const listeners: FakeMonitorListener[] = [];
        monitor({
          addEventListener: (type, listener) => {
            if (type === "downloadprogress") listeners.push(listener);
          },
        });
        for (const loaded of this.emit) {
          for (const listener of listeners) listener({ loaded });
        }
      }
      const session = {
        prompt: (input: string): Promise<BoundaryValue> => {
          platform.prompts.push(input);
          return Promise.resolve(platform.answer);
        },
        destroy: () => {
          platform.destroys += 1;
        },
      };
      const created: BoundaryValue = overlapCast(session);
      return Promise.resolve(created);
    },
  };
  return platform;
}

function installGlobal(value: BoundaryValue): void {
  // SAFETY: the global object is a runtime record; the member is removed again
  // in afterEach so no other test observes it.
  const globals: MutableBoundaryObject = overlapCast(globalThis);
  globals.LanguageModel = value;
}

/** Undefined is how an absent member reads, and the detector checks for it. */
function removeGlobal(): void {
  // SAFETY: same global record established by installGlobal above.
  const globals: MutableBoundaryObject = overlapCast(globalThis);
  globals.LanguageModel = undefined;
}

function asBoundary(platform: FakePlatform): BoundaryValue {
  // SAFETY: the fake implements the LanguageModel slice detect.ts reads, which
  // is the contract the detector re-validates member by member.
  const value: BoundaryValue = overlapCast(platform);
  return value;
}

afterEach(() => {
  removeGlobal();
});

describe("detectLocalLanguageModel", () => {
  it("returns null when the browser has no LanguageModel", () => {
    expect(detectLocalLanguageModel()).toBeNull();
  });

  it("returns null when the global carries no create()", () => {
    installGlobal({ availability: () => Promise.resolve("available") });
    expect(detectLocalLanguageModel()).toBeNull();
  });

  it("accepts an interface object, which is how Chrome exposes it", async () => {
    const platform = createFakePlatform();
    function LanguageModelConstructor(): void {}
    LanguageModelConstructor.availability = () =>
      Promise.resolve(platform.state);
    LanguageModelConstructor.create = (payload: FakePayload) =>
      platform.create(payload);
    // SAFETY: a constructor carries the static members the detector reads, the
    // same way the shipping interface object does.
    const value: BoundaryValue = overlapCast(LanguageModelConstructor);
    installGlobal(value);
    const api = detectLocalLanguageModel();
    expect(api).not.toBeNull();
    expect(await api?.availability()).toBe("available");
  });

  it("binds availability to the platform object and normalizes its states", async () => {
    const platform = createFakePlatform();
    installGlobal(asBoundary(platform));
    const api = detectLocalLanguageModel();
    expect(api).not.toBeNull();
    if (api === null) return;

    const seen: string[] = [];
    for (const state of [
      "available",
      "readily",
      "downloading",
      "downloadable",
      "after-download",
      "unavailable",
      "something-new",
    ]) {
      platform.state = state;
      seen.push(await api.availability());
    }
    expect(seen).toEqual([
      "available",
      "available",
      "downloading",
      "downloadable",
      "downloadable",
      "unavailable",
      "unavailable",
    ]);
  });

  it("sends only the members the caller supplied", async () => {
    const platform = createFakePlatform();
    installGlobal(asBoundary(platform));
    const api = detectLocalLanguageModel();
    if (api === null) throw new Error("expected a detected api");

    await api.create({ initialPrompts: [], monitor: null, signal: null });
    const [bare] = platform.payloads;
    expect(bare?.initialPrompts).toBeUndefined();
    expect(bare?.monitor).toBeUndefined();
    expect(bare?.signal).toBeUndefined();

    const controller = new AbortController();
    await api.create({
      initialPrompts: [{ role: "system", content: "Rules." }],
      monitor: () => {},
      signal: controller.signal,
    });
    const full = platform.payloads[1];
    expect(full?.initialPrompts).toEqual([
      { role: "system", content: "Rules." },
    ]);
    expect(full?.signal).toBe(controller.signal);
    expect(full?.monitor).toBeDefined();
  });

  it("reports download progress as a clamped fraction", async () => {
    const platform = createFakePlatform();
    platform.emit = [-1, 0.25, 4];
    installGlobal(asBoundary(platform));
    const api = detectLocalLanguageModel();
    if (api === null) throw new Error("expected a detected api");

    const seen: number[] = [];
    await api.create({
      initialPrompts: [],
      monitor: (progress) => seen.push(progress),
      signal: null,
    });
    expect(seen).toEqual([0, 0.25, 1]);
  });

  it("normalizes the session and refuses a non-text answer", async () => {
    const platform = createFakePlatform();
    installGlobal(asBoundary(platform));
    const api = detectLocalLanguageModel();
    if (api === null) throw new Error("expected a detected api");

    const controller = new AbortController();
    const session = await api.create({
      initialPrompts: [],
      monitor: null,
      signal: null,
    });
    expect(await session.prompt("Ask.", { signal: controller.signal })).toBe(
      "Answer.",
    );
    expect(platform.prompts).toEqual(["Ask."]);
    session.destroy();
    expect(platform.destroys).toBe(1);

    platform.answer = 7;
    await expect(
      session.prompt("Ask again.", { signal: controller.signal }),
    ).rejects.toThrow(/not text/iu);
  });

  it("rejects a created session that cannot be prompted", async () => {
    const platform = createFakePlatform();
    platform.create = () => Promise.resolve({ destroy: () => {} });
    installGlobal(asBoundary(platform));
    const api = detectLocalLanguageModel();
    if (api === null) throw new Error("expected a detected api");
    await expect(
      api.create({ initialPrompts: [], monitor: null, signal: null }),
    ).rejects.toThrow(/usable prompt/iu);
  });
});
