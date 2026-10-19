import { afterEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { aiConnectionDraft } from "./presets.js";
import {
  REPLICATE_TOKEN,
  replicateTlsFixture,
} from "./replicate-tls.test-support.js";
import { ReplicatePredictionInterrupted } from "./replicate-types.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { bindAiConnectionTransport } from "./transport.js";
import { aiVaultSeams } from "./vault-guard.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const predictionInput = {
  subject: "Transient model-specific JSON",
  iterations: 1,
};
const input = {
  model: "owner/model",
  messages: [
    { role: "user" as const, content: JSON.stringify(predictionInput) },
  ],
};
async function setup(saved = false) {
  const vault = await runtimeFixture();
  const http = await replicateTlsFixture();
  http.state.pollsBeforeSuccess = 0;
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const draft = {
    ...aiConnectionDraft("replicate"),
    model: "owner/model",
    apiKey: REPLICATE_TOKEN,
  };
  const view = saved
    ? await saveAiConnection(draft, undefined, predictionInput, {
        prediction: { pollIntervalMs: 10 },
      })
    : undefined;
  http.state.mode = "held";
  const caller = new AbortController();
  const cancellation = new AbortController();
  const text = vi.fn();
  const prediction = { signal: cancellation.signal, pollIntervalMs: 10 };
  const options = { signal: caller.signal, prediction };
  const runtime = {
    signal: caller.signal,
    assertCurrent: () => caller.signal.throwIfAborted(),
  };
  return {
    http,
    draft,
    view,
    caller,
    cancellation,
    text,
    prediction,
    options,
    runtime,
  };
}
function start(f: Awaited<ReturnType<typeof setup>>, operation: string) {
  if (operation === "saved") {
    if (!f.view) throw new Error("Expected actual saved prediction");
    return performSavedAiInference(
      f.view.connectionId,
      input,
      f.runtime,
      f.text,
      f.prediction,
    );
  }
  return operation === "save"
    ? saveAiConnection(f.draft, undefined, predictionInput, f.options)
    : testAiConnection(f.draft, undefined, predictionInput, f.options);
}
function rejected(operation: ReturnType<typeof start>): Promise<Error> {
  return operation.then(
    () => {
      throw new Error("Expected prediction failure");
    },
    (error) => {
      if (!(error instanceof Error))
        throw new Error("Unexpected non-error rejection");
      return error;
    },
  );
}
function heldClosed(f: Awaited<ReturnType<typeof setup>>) {
  return vi.waitFor(() =>
    expect(
      [...f.http.requests].reverse().find((row) => row.method === "GET"),
    ).toMatchObject({ closed: true, ended: false }),
  );
}
it.each(["test", "save", "saved"])(
  "threads explicit %s user cancellation to the exact created ID without revoking credential authority",
  async (operation) => {
    const f = await setup(operation === "saved");
    const before = f.http.requests.length;
    const outcome = rejected(start(f, operation));
    await f.http.held;
    f.cancellation.abort();
    const error = await outcome;
    expect(error).toBeInstanceOf(ReplicatePredictionInterrupted);
    expect(error).toMatchObject({ cancellationRequested: true });
    await heldClosed(f);
    expect(f.caller.signal.aborted).toBe(false);
    expect(f.http.port.signal.aborted).toBe(false);
    expect(
      f.http.requests.slice(before).map((row) => [row.method, row.path]),
    ).toEqual([
      ["POST", "/v1/models/owner/model/predictions"],
      [
        "GET",
        operation === "saved"
          ? "/v1/predictions/owned-2"
          : "/v1/predictions/owned-1",
      ],
      [
        "POST",
        operation === "saved"
          ? "/v1/predictions/owned-2/cancel"
          : "/v1/predictions/owned-1/cancel",
      ],
    ]);
    expect(f.http.requests.at(-1)?.authorization).toBe(
      `Bearer ${REPLICATE_TOKEN}`,
    );
    expect(f.text).not.toHaveBeenCalled();
    expect(readDeviceRows()).toHaveLength(operation === "saved" ? 1 : 0);
  },
);
it.each(["vault", "caller", "lease", "registration", "record"])(
  "%s authority withdrawal prevents a later explicit Cancel from authenticating another request",
  async (withdrawal) => {
    const f = await setup(true);
    const count = f.http.requests.length;
    const replacement = vi.fn<typeof fetch>();
    const outcome = rejected(start(f, "saved"));
    await f.http.held;
    if (withdrawal === "vault") vaultStore.lock();
    else if (withdrawal === "caller") f.caller.abort();
    else if (withdrawal === "lease") f.http.abort.abort();
    else if (withdrawal === "registration") {
      const release = bindAiConnectionTransport({
        ...f.http.port,
        fetch: replacement,
      });
      closes.push(async () => release());
    } else {
      if (!f.view) throw new Error("Expected saved target");
      await deleteAiConnection(f.view.connectionId);
    }
    f.cancellation.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await heldClosed(f);
    expect(f.http.requests).toHaveLength(count + 2);
    expect(f.http.requests.some((row) => row.path.endsWith("/cancel"))).toBe(
      false,
    );
    expect(replacement).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  },
);
it.each(["test", "save"])(
  "physically closes held %s when its original mounted caller ends, without remote cancellation",
  async (operation) => {
    const f = await setup();
    const outcome = rejected(start(f, operation));
    await f.http.held;
    f.caller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await heldClosed(f);
    expect(f.http.requests).toHaveLength(2);
    expect(readDeviceRows()).toEqual([]);
    expect(f.cancellation.signal.aborted).toBe(false);
  },
);
it.each(["test", "save"])(
  "admits no %s request from an already-ended caller",
  async (operation) => {
    const f = await setup();
    f.caller.abort();
    await expect(start(f, operation)).rejects.toThrow();
    expect(f.http.requests).toEqual([]);
    expect(readDeviceRows()).toEqual([]);
  },
);
it("reports unconfirmed cancellation truthfully when the actual cancellation endpoint rejects authentication", async () => {
  const f = await setup();
  const outcome = rejected(start(f, "test"));
  await f.http.held;
  f.http.state.mode = "forbidden";
  f.cancellation.abort();
  expect(await outcome).toMatchObject({ cancellationRequested: false });
  await heldClosed(f);
  expect(f.http.requests.at(-1)?.path).toBe("/v1/predictions/owned-1/cancel");
  expect(readDeviceRows()).toEqual([]);
});

it.each(["test", "save"])(
  "captures the original %s caller before vault acquisition yields",
  async (operation) => {
    const f = await setup();
    const outcome = rejected(start(f, operation));
    f.options.signal = new AbortController().signal;
    f.caller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(f.http.requests).toEqual([]);
    expect(readDeviceRows()).toEqual([]);
  },
);
it.each(["test", "save", "saved"])(
  "retains the original %s explicit cancel signal across vault acquisition",
  async (operation) => {
    const f = await setup(operation === "saved");
    const outcome = rejected(start(f, operation));
    f.prediction.signal = new AbortController().signal;
    await f.http.held;
    f.cancellation.abort();
    expect(await outcome).toMatchObject({ cancellationRequested: true });
    await heldClosed(f);
    expect(f.http.requests.at(-1)?.path).toMatch(
      /\/predictions\/owned-[12]\/cancel$/,
    );
    expect(f.caller.signal.aborted).toBe(false);
  },
);

function holdVaultCapture() {
  const original = aiVaultSeams.capture;
  let notify = () => {};
  let release = () => {};
  const captured = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(aiVaultSeams, "capture").mockImplementationOnce(async () => {
    const held = await original();
    notify();
    await resumed;
    return held;
  });
  return { captured, release };
}
it.each(["signal", "method", "both"])(
  "rejects original saved caller %s mutation while a real vault-capture result is held",
  async (mutation) => {
    const f = await setup(true);
    if (!f.view) throw new Error("Expected saved connection");
    f.http.state.mode = "complete";
    const before = f.http.requests.length;
    const originalCheck = vi.fn();
    const runtime = { signal: f.caller.signal, assertCurrent: originalCheck };
    const gate = holdVaultCapture();
    const outcome = performSavedAiInference(
      f.view.connectionId,
      input,
      runtime,
      f.text,
      f.prediction,
    );
    const failure = rejected(outcome);
    await gate.captured;
    if (mutation !== "method") runtime.signal = new AbortController().signal;
    if (mutation !== "signal") runtime.assertCurrent = vi.fn();
    if (mutation !== "method") f.caller.abort();
    gate.release();
    expect(await failure).toMatchObject({
      message: "The AI caller changed. Restart the operation.",
    });
    expect(f.http.requests).toHaveLength(before);
    expect(f.text).not.toHaveBeenCalled();
  },
);
it("rejects an already-ended saved caller before acquiring another real vault session", async () => {
  const f = await setup(true);
  if (!f.view) throw new Error("Expected saved connection");
  const capture = vi.spyOn(aiVaultSeams, "capture");
  f.caller.abort();
  await expect(
    performSavedAiInference(f.view.connectionId, input, f.runtime),
  ).rejects.toThrow();
  expect(capture).not.toHaveBeenCalled();
});
it.each(["signal", "method"])(
  "detects saved caller %s replacement from inside its original callback",
  async (mutation) => {
    const f = await setup(true);
    if (!f.view) throw new Error("Expected saved connection");
    f.http.state.mode = "complete";
    const before = f.http.requests.length;
    const runtime = {
      signal: f.caller.signal,
      assertCurrent() {
        expect(this).toBe(runtime);
        if (mutation === "signal") this.signal = new AbortController().signal;
        else this.assertCurrent = () => {};
      },
    };
    const capture = vi.spyOn(aiVaultSeams, "capture");
    await expect(
      performSavedAiInference(
        f.view.connectionId,
        input,
        runtime,
        f.text,
        f.prediction,
      ),
    ).rejects.toThrow("caller changed");
    expect(capture).not.toHaveBeenCalled();
    expect(f.http.requests).toHaveLength(before);
  },
);
it("preserves the original saved caller method receiver throughout a real terminal prediction", async () => {
  const f = await setup(true);
  if (!f.view) throw new Error("Expected saved connection");
  f.http.state.mode = "complete";
  const runtime = {
    signal: f.caller.signal,
    checks: 0,
    assertCurrent() {
      expect(this).toBe(runtime);
      this.checks += 1;
      this.signal.throwIfAborted();
    },
  };
  const result = await performSavedAiInference(
    f.view.connectionId,
    input,
    runtime,
    f.text,
    f.prediction,
  );
  expect(result.answer).toContain("Independently produced prediction.");
  expect(runtime.checks).toBeGreaterThan(1);
});
