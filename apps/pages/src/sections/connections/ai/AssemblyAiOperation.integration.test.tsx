/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { inferAssemblyAi } from "@opensesame/app-core/lib/ai-connections/assemblyai-inference.js";
import type { AssemblySpeechTarget } from "@opensesame/app-core/lib/ai-connections/assemblyai-target.js";
import {
  ASSEMBLY_KEY,
  ASSEMBLY_TEXT,
  assemblyTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/assemblyai-tls.test-support.js";
import { ownedSpeechAudio } from "@opensesame/app-core/lib/ai-connections/speech-tls.test-support.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAiOperation } from "./useAiConnection.js";

type Http = Awaited<ReturnType<typeof assemblyTlsFixture>>;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Exercises the shared operation hook without prematurely admitting a saved family. */
function Operation({
  http,
  target,
}: { http: Http; target: AssemblySpeechTarget }) {
  const [answer, setAnswer] = useState("");
  const withdraw = useCallback(() => setAnswer(""), []);
  const pending = useAiOperation(() => {}, withdraw);
  return (
    <section>
      <button
        type="button"
        disabled={pending.busy}
        onClick={() => {
          setAnswer("");
          void pending.runAi(async (owner, signal) => {
            const result = await inferAssemblyAi(
              target,
              ownedSpeechAudio(),
              {
                ...http.port,
                signal: AbortSignal.any([http.port.signal, owner.signal]),
              },
              owner.check,
              { signal },
            );
            owner.check();
            setAnswer(result.answer);
            return undefined;
          });
        }}
      >
        Start owned transcription
      </button>
      <button type="button" onClick={pending.onCancel}>
        Stop waiting
      </button>
      <button type="button" onClick={pending.clear}>
        Withdraw operation
      </button>
      <output aria-label="Transcript">{answer}</output>
      <output aria-label="Operation result">{pending.result}</output>
      <output aria-label="Operation failure">{pending.failure}</output>
    </section>
  );
}
async function setup(providerId = "assemblyai") {
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  closes.push(vault.close);
  const model =
    providerId === "byo-ai" ? "operator-speech-2" : "universal-3-5-pro";
  const http = await assemblyTlsFixture({
    baseUrl:
      providerId === "byo-ai"
        ? "https://operator.example/owned/speech"
        : undefined,
    model,
  });
  closes.push(http.close);
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, delay, ...args) =>
      timer(handler, delay === 3000 ? 1 : delay, ...args),
  );
  const ambient = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No ambient fallback"));
  const target: AssemblySpeechTarget = {
    providerId,
    baseUrl: http.baseUrl,
    model,
    authentication: "api-key",
    apiKey: ASSEMBLY_KEY,
  };
  const mounted = render(<Operation http={http} target={target} />);
  return { http, mounted, ambient };
}
function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}
async function started(f: Awaited<ReturnType<typeof setup>>) {
  click("Start owned transcription");
  await f.http.held;
  const row = f.http.records.find((record) => !record.ended);
  expect(row).toMatchObject({
    authenticated: true,
    closed: false,
    ended: false,
  });
  return row;
}
async function settled() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Start owned transcription" }),
    ).toHaveProperty("disabled", false),
  );
}

it.each(["assemblyai", "byo-ai"])(
  "shared operation consumes the actual %s upload/job/poll/delete transcript",
  async (provider) => {
    const f = await setup(provider);
    click("Start owned transcription");
    await waitFor(() =>
      expect(screen.getByLabelText("Transcript").textContent).toBe(
        ASSEMBLY_TEXT,
      ),
    );
    await settled();
    expect(f.http.records.map((row) => row.phase)).toEqual([
      "upload",
      "create",
      "poll",
      "poll",
      "delete",
    ]);
    expect(f.http.records.every((row) => row.authenticated)).toBe(true);
    expect(screen.getByLabelText("Operation failure").textContent).toBe("");
    expect(document.body.textContent).not.toContain(ASSEMBLY_KEY);
    expect(f.ambient).not.toHaveBeenCalled();
  },
);
it.each(["assemblyai", "byo-ai"])(
  "shared %s user Cancel closes the held poll and reports deletion without a transcript or processing-stop claim",
  async (provider) => {
    const f = await setup(provider);
    f.http.state.hold = "poll";
    const held = await started(f);
    click("Stop waiting");
    await waitFor(() =>
      expect(screen.getByLabelText("Operation result").textContent).toBe(
        "Stopped waiting; transcript deletion was acknowledged. Provider processing or charges may continue.",
      ),
    );
    await settled();
    await waitFor(() => expect(held?.closed).toBe(true));
    expect(held?.ended).toBe(false);
    expect(f.http.records.map((row) => row.phase)).toEqual([
      "upload",
      "create",
      "poll",
      "delete",
    ]);
    expect(f.http.records.at(-1)?.path).toBe(
      `${new URL(f.http.baseUrl).pathname}/transcript/${f.http.id}`,
    );
    expect(f.http.records.some((row) => row.path.includes("cancel"))).toBe(
      false,
    );
    expect(screen.getByLabelText("Transcript").textContent).toBe("");
    expect(screen.getByLabelText("Operation failure").textContent).toBe("");
    expect(document.body.textContent).not.toContain(ASSEMBLY_KEY);
    expect(f.ambient).not.toHaveBeenCalled();
  },
);
it("unconfirmed deletion remains a shared operation failure, never an inference or cancellation success", async () => {
  const f = await setup();
  f.http.state.hold = "poll";
  await started(f);
  f.http.state.phase = "delete";
  f.http.state.mode = "forbidden";
  click("Stop waiting");
  await waitFor(() =>
    expect(screen.getByLabelText("Operation failure").textContent).toBe(
      "Stopped waiting; remote transcript removal was not confirmed.",
    ),
  );
  await settled();
  expect(f.http.records.at(-1)?.phase).toBe("delete");
  expect(screen.getByLabelText("Operation result").textContent).toBe("");
  expect(screen.getByLabelText("Transcript").textContent).toBe("");
});
it.each(["upload", "create"] as const)(
  "Cancel during held %s never guesses a job ID and reports removal uncertainty",
  async (phase) => {
    const f = await setup();
    f.http.state.hold = phase;
    const held = await started(f);
    click("Stop waiting");
    await waitFor(() =>
      expect(screen.getByLabelText("Operation failure").textContent).toBe(
        "Stopped waiting; remote transcript removal was not confirmed.",
      ),
    );
    await settled();
    await waitFor(() => expect(held?.closed).toBe(true));
    expect(held?.ended).toBe(false);
    expect(f.http.records.some((row) => row.phase === "delete")).toBe(false);
    expect(screen.getByLabelText("Operation result").textContent).toBe("");
  },
);
it.each(["lock", "unmount", "withdraw"])(
  "actual %s withdraws the shared owner, physically ends HTTP and forbids authenticated cleanup",
  async (withdrawal) => {
    const f = await setup();
    f.http.state.hold = "poll";
    const held = await started(f);
    await act(async () => {
      if (withdrawal === "lock") vaultStore.lock();
      else if (withdrawal === "unmount") f.mounted.unmount();
      else click("Withdraw operation");
    });
    await waitFor(() => expect(held?.closed).toBe(true));
    expect(held?.ended).toBe(false);
    f.http.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.http.records.map((row) => row.phase)).toEqual([
      "upload",
      "create",
      "poll",
    ]);
    expect(screen.queryByLabelText("Transcript")?.textContent ?? "").toBe("");
    expect(screen.queryByLabelText("Operation result")?.textContent ?? "").toBe(
      "",
    );
    expect(
      screen.queryByLabelText("Operation failure")?.textContent ?? "",
    ).toBe("");
    expect(f.ambient).not.toHaveBeenCalled();
  },
);
it("vault withdrawal while user-requested DELETE is held closes cleanup and suppresses its late acknowledgment", async () => {
  const f = await setup();
  f.http.state.hold = "poll";
  await started(f);
  f.http.state.hold = "delete";
  click("Stop waiting");
  await waitFor(() => expect(f.http.records.at(-1)?.phase).toBe("delete"));
  const deletion = f.http.records.at(-1);
  act(() => vaultStore.lock());
  await waitFor(() => expect(deletion?.closed).toBe(true));
  expect(deletion?.ended).toBe(false);
  f.http.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.http.records).toHaveLength(4);
  expect(screen.getByLabelText("Operation result").textContent).toBe("");
  expect(screen.getByLabelText("Operation failure").textContent).toBe("");
  expect(screen.getByLabelText("Transcript").textContent).toBe("");
});
