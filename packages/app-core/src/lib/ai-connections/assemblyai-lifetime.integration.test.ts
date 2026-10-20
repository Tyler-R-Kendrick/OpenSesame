import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferAssemblyAi } from "./assemblyai-inference.js";
import {
  type AssemblySpeechTarget,
  AssemblyTranscriptInterrupted,
  validateAssemblySpeechTarget,
} from "./assemblyai-target.js";
import {
  ASSEMBLY_KEY,
  assemblyTlsFixture,
} from "./assemblyai-tls.test-support.js";
import { ownedSpeechAudio } from "./speech-tls.test-support.js";
import type { AiConnectionTransport } from "./types.js";

const fixtures: Awaited<ReturnType<typeof assemblyTlsFixture>>[] = [];
async function fixture() {
  const local = await assemblyTlsFixture();
  fixtures.push(local);
  return local;
}
function target(): AssemblySpeechTarget {
  return {
    providerId: "assemblyai",
    baseUrl: "https://api.assemblyai.com/v2",
    model: "universal-3-5-pro",
    authentication: "api-key",
    apiKey: ASSEMBLY_KEY,
  };
}
beforeEach(() => {
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, delay, ...args) =>
      timer(handler, delay === 2000 ? 1 : delay, ...args),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const local of fixtures.splice(0)) await local.close();
});

describe("AssemblyAI original authority, cancellation and deletion lifetime", () => {
  it("user cancellation physically closes a held poll then deletes only its captured job once", async () => {
    const local = await fixture();
    local.state.hold = "poll";
    const user = new AbortController();
    const operation = inferAssemblyAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
      { signal: user.signal },
    );
    const rejected = expect(operation).rejects.toMatchObject({
      deletionAcknowledged: true,
    });
    await local.held;
    const poll = local.records.find((row) => row.phase === "poll");
    expect(poll).toMatchObject({
      authenticated: true,
      ended: false,
      closed: false,
    });
    user.abort();
    user.abort();
    await rejected;
    await vi.waitFor(() => expect(poll?.closed).toBe(true));
    expect(poll?.ended).toBe(false);
    expect(local.records.map((row) => row.phase)).toEqual([
      "upload",
      "create",
      "poll",
      "delete",
    ]);
    expect(local.records.at(-1)?.path).toBe(`/v2/transcript/${local.id}`);
    expect(local.records.some((row) => row.path.includes("cancel"))).toBe(
      false,
    );
  });
  it.each(["upload", "create"] as const)(
    "user cancel during held %s closes the socket and never guesses a deletion ID",
    async (phase) => {
      const local = await fixture();
      local.state.hold = phase;
      const user = new AbortController();
      const operation = inferAssemblyAi(
        target(),
        ownedSpeechAudio(),
        local.port,
        () => {},
        { signal: user.signal },
      );
      const rejected = expect(operation).rejects.toMatchObject({
        deletionAcknowledged: false,
      });
      await local.held;
      user.abort();
      await rejected;
      await vi.waitFor(() => expect(local.records.at(-1)?.closed).toBe(true));
      expect(local.records.some((row) => row.phase === "delete")).toBe(false);
      expect(local.records.at(-1)?.ended).toBe(false);
    },
  );
  it.each(["caller", "owner", "transport"] as const)(
    "%s withdrawal physically closes every active stage without authenticated follow-up",
    async (reason) => {
      for (const phase of ["upload", "create", "poll", "delete"] as const) {
        const local = await fixture();
        local.state.hold = phase;
        const caller = new AbortController();
        const owner = new AbortController();
        const port = {
          ...local.port,
          signal: AbortSignal.any([
            local.port.signal,
            caller.signal,
            owner.signal,
          ]),
        };
        const operation = inferAssemblyAi(
          target(),
          ownedSpeechAudio(),
          port,
          () => owner.signal.throwIfAborted(),
        );
        const rejected = expect(operation).rejects.toThrow();
        await local.held;
        const count = local.records.length;
        if (reason === "caller") caller.abort();
        else if (reason === "owner") owner.abort();
        else local.abort.abort();
        await rejected;
        await vi.waitFor(() => expect(local.records.at(-1)?.closed).toBe(true));
        expect(local.records.at(-1)?.ended).toBe(false);
        expect(local.records).toHaveLength(count);
        await expect(
          inferAssemblyAi(target(), ownedSpeechAudio(), port, () =>
            owner.signal.throwIfAborted(),
          ),
        ).rejects.toThrow();
        expect(local.records).toHaveLength(count);
      }
    },
  );
  it.each(["signal", "fetch", "assertCurrent", "owner"] as const)(
    "rejects a late transcript and refuses cleanup after original %s replacement",
    async (change) => {
      const local = await fixture();
      local.state.hold = "poll";
      let current = true;
      const operation = inferAssemblyAi(
        target(),
        ownedSpeechAudio(),
        local.port,
        () => {
          if (!current) throw new Error("Original custody ended");
        },
      );
      const rejected = expect(operation).rejects.toThrow();
      await local.held;
      if (change === "signal") local.port.signal = new AbortController().signal;
      if (change === "fetch") local.port.fetch = vi.fn();
      if (change === "assertCurrent") local.port.assertCurrent = () => {};
      if (change === "owner") current = false;
      local.release();
      await rejected;
      await vi.waitFor(() => expect(local.records.at(-1)?.closed).toBe(true));
      expect(local.records.map((row) => row.phase)).toEqual([
        "upload",
        "create",
        "poll",
      ]);
    },
  );
  it("preserves the exact original fetch receiver and finite HTTP policy across upload/create/poll/delete", async () => {
    const local = await fixture();
    const original = local.port.fetch;
    let calls = 0;
    local.port.fetch = function (this: AiConnectionTransport, input, init) {
      expect(this).toBe(local.port);
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(local.port.signal);
      calls++;
      return original.call(this, input, init);
    };
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).resolves.toHaveProperty("answer");
    expect(calls).toBe(5);
  });
  it("cancels an owned job during the real 2s wait without dispatching a GET", async () => {
    vi.restoreAllMocks();
    const local = await fixture();
    const user = new AbortController();
    const operation = inferAssemblyAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
      { signal: user.signal },
    );
    const rejected = expect(operation).rejects.toMatchObject({
      deletionAcknowledged: true,
    });
    await vi.waitFor(() =>
      expect(local.records.find((row) => row.phase === "create")?.ended).toBe(
        true,
      ),
    );
    user.abort();
    await rejected;
    expect(local.records.map((row) => row.phase)).toEqual([
      "upload",
      "create",
      "delete",
    ]);
  });
  it("bounds a held poll with a narrowed workflow deadline and still requests owned deletion", async () => {
    const local = await fixture();
    local.state.hold = "poll";
    const operation = inferAssemblyAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
      { timeoutMs: 200 },
    );
    const rejected = expect(operation).rejects.toMatchObject({
      deletionAcknowledged: true,
    });
    await local.held;
    await rejected;
    await vi.waitFor(() =>
      expect(local.records.find((row) => row.phase === "poll")?.closed).toBe(
        true,
      ),
    );
    expect(local.records.at(-1)?.phase).toBe("delete");
  });
  it("continues a single bounded DELETE after user cancel during cleanup, without accepting a transcript", async () => {
    const local = await fixture();
    local.state.hold = "delete";
    const user = new AbortController();
    const operation = inferAssemblyAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
      { signal: user.signal },
    );
    const rejected = expect(operation).rejects.toMatchObject({
      deletionAcknowledged: true,
    });
    await local.held;
    user.abort();
    expect(local.records.at(-1)?.closed).toBe(false);
    local.release();
    await rejected;
    expect(local.records.filter((row) => row.phase === "delete")).toHaveLength(
      1,
    );
  });
  it("reports removal unconfirmed when the cancellation DELETE fails instead of claiming provider processing stopped", async () => {
    const local = await fixture();
    local.state.hold = "poll";
    local.state.phase = "delete";
    local.state.mode = "forbidden";
    const user = new AbortController();
    const operation = inferAssemblyAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
      { signal: user.signal },
    );
    const rejected = expect(operation).rejects.toMatchObject({
      deletionAcknowledged: false,
    });
    await local.held;
    user.abort();
    await rejected;
    expect(local.records.filter((row) => row.phase === "delete")).toHaveLength(
      1,
    );
    expect(new AssemblyTranscriptInterrupted(false).message).toContain(
      "not confirmed",
    );
    expect(new AssemblyTranscriptInterrupted(true).message).toContain(
      "processing or charges may continue",
    );
  });
  it("does not dispatch any request for an already cancelled user", async () => {
    const local = await fixture();
    const user = new AbortController();
    user.abort();
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}, {
        signal: user.signal,
      }),
    ).rejects.toMatchObject({ deletionAcknowledged: false });
    expect(local.records).toEqual([]);
  });
  it("rejects reentrant transport replacement inside the original owner before upload", async () => {
    const local = await fixture();
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {
        local.port.signal = new AbortController().signal;
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(local.records).toEqual([]);
  });
  it("bounds a held cleanup DELETE to its requested 10s budget and physically closes it", async () => {
    const local = await fixture();
    local.state.hold = "delete";
    const timeout = AbortSignal.timeout;
    const deadlines = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) =>
        timeout(milliseconds === 10_000 ? 100 : milliseconds),
      );
    const operation = inferAssemblyAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
    );
    const rejected = expect(operation).rejects.toThrow(
      "Remote transcript removal was not confirmed",
    );
    await local.held;
    await rejected;
    await vi.waitFor(() => expect(local.records.at(-1)?.closed).toBe(true));
    expect(local.records.at(-1)).toMatchObject({
      phase: "delete",
      ended: false,
    });
    expect(local.records.filter((row) => row.phase === "delete")).toHaveLength(
      1,
    );
    expect(deadlines).toHaveBeenCalledWith(10_000);
  });
  it.each(["upload", "delete"] as const)(
    "closes an unread denied %s response on local operation exit",
    async (phase) => {
      const local = await fixture();
      local.state.phase = phase;
      local.state.mode = "forbidden";
      local.state.hold = phase;
      const operation = inferAssemblyAi(
        target(),
        ownedSpeechAudio(),
        local.port,
        () => {},
      );
      const rejected = expect(operation).rejects.toThrow();
      await local.held;
      await rejected;
      await vi.waitFor(() => expect(local.records.at(-1)?.closed).toBe(true));
      expect(local.records.at(-1)).toMatchObject({ phase, ended: false });
      expect(
        local.records.filter((row) => row.phase === "delete"),
      ).toHaveLength(phase === "delete" ? 1 : 0);
    },
  );
  it("validates public targets without admitting absent credentials to inference", () => {
    expect(
      validateAssemblySpeechTarget({ ...target(), apiKey: "" }, false).apiKey,
    ).toBe("");
    expect(() =>
      validateAssemblySpeechTarget({ ...target(), apiKey: "" }),
    ).toThrow();
  });
});
