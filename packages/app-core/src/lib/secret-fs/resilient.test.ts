import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { failureOf } from "./files.conformance.js";
import { describeSecretFiles } from "./files.conformance.js";
import { revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { resilient } from "./resilient.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const FAST = {
  backoff: Duration.millis(1),
  attemptTimeout: Duration.millis(40),
  breakerReset: Duration.millis(60),
};

/** A store that fails the way a network does, on a script the test writes. */
function flaky(
  script: (call: number, op: string) => "ok" | "down" | "hang" | "lose-answer",
) {
  const inner = makeMemorySecretFiles();
  const calls: string[] = [];
  const down = (path: string) =>
    Effect.fail(
      new SecretFsUnavailable({ path, reason: "connection refused" }),
    );
  const gate =
    <A>(op: string, path: string, run: () => Effect.Effect<A, SecretFsError>) =>
    (): Effect.Effect<A, SecretFsError> => {
      calls.push(op);
      const step = script(calls.length, op);
      if (step === "down") return down(path);
      if (step === "hang") return Effect.never;
      if (step === "lose-answer") {
        return run().pipe(Effect.andThen(down(path)));
      }
      return run();
    };
  const files: SecretFiles = {
    read: (path) => Effect.suspend(gate("read", path, () => inner.read(path))),
    write: (path, data, options) =>
      Effect.suspend(
        gate("write", path, () => inner.write(path, data, options)),
      ),
    remove: (path) =>
      Effect.suspend(gate("remove", path, () => inner.remove(path))),
    list: (prefix) =>
      Effect.suspend(gate("list", prefix, () => inner.list(prefix))),
  };
  return { files, inner, calls };
}

describeSecretFiles(
  "a resilient wrapper over the emulated store",
  async () => ({
    files: await Effect.runPromise(resilient(makeMemorySecretFiles(), FAST)),
  }),
);

describe("a resilient store", () => {
  it("retries an unreachable store until it answers", async () => {
    const store = flaky((call) => (call < 3 ? "down" : "ok"));
    const files = await Effect.runPromise(resilient(store.files, FAST));
    await Effect.runPromise(files.write("a.json", bytes("x")));
    expect(store.calls).toEqual(["write", "write", "write"]);
    expect(store.inner.snapshot().has("a.json")).toBe(true);
  });

  it("gives up after its retries and says the store was unreachable", async () => {
    const store = flaky(() => "down");
    const files = await Effect.runPromise(
      resilient(store.files, { ...FAST, retries: 2, breakerThreshold: 99 }),
    );
    expect((await failureOf(files.read("a.json")))._tag).toBe(
      "SecretFsUnavailable",
    );
    expect(store.calls).toHaveLength(3);
  });

  it("treats a missing file, a refusal and a conflict as answers, not outages", async () => {
    const store = flaky(() => "ok");
    const files = await Effect.runPromise(resilient(store.files, FAST));
    expect((await failureOf(files.read("none.json")))._tag).toBe(
      "SecretFsNotFound",
    );
    expect((await failureOf(files.read("../x")))._tag).toBe("SecretFsRejected");
    await Effect.runPromise(files.write("a.json", bytes("1")));
    const before = store.calls.length;
    const conflict = await failureOf(
      files.write("a.json", bytes("2"), { ifRevision: null }),
    );
    expect(conflict._tag).toBe("SecretFsConflict");
    expect(store.calls.length - before).toBe(1);
  });

  it("counts a hung request as a failure instead of waiting for it", async () => {
    const store = flaky((call) => (call === 1 ? "hang" : "ok"));
    const files = await Effect.runPromise(resilient(store.files, FAST));
    await Effect.runPromise(files.write("a.json", bytes("x")));
    expect(store.calls).toEqual(["write", "write"]);
  });

  it("counts a write whose answer was lost as done, not as a conflict", async () => {
    const store = flaky((call) => (call === 1 ? "lose-answer" : "ok"));
    const files = await Effect.runPromise(resilient(store.files, FAST));
    const revision = await Effect.runPromise(
      files.write("a.json", bytes("kept"), { ifRevision: null }),
    );
    expect(revision).toBe(revisionOf(bytes("kept")));
    expect(store.calls).toEqual(["write", "write"]);
  });

  it("counts a write that landed and then hung as done, not as a conflict", async () => {
    const inner = makeMemorySecretFiles();
    let calls = 0;
    const countCall = () => {
      calls += 1;
      return calls;
    };
    const slow: SecretFiles = {
      ...inner,
      write: (path, data, options) =>
        inner
          .write(path, data, options)
          .pipe(
            Effect.andThen(
              countCall() === 1
                ? Effect.never
                : Effect.succeed(revisionOf(data)),
            ),
          ),
    };
    const files = await Effect.runPromise(resilient(slow, FAST));
    const revision = await Effect.runPromise(
      files.write("a.json", bytes("kept"), { ifRevision: null }),
    );
    expect(revision).toBe(revisionOf(bytes("kept")));
    expect(calls).toBe(2);
  });

  it("opens the circuit after repeated outages, then lets one probe through", async () => {
    let healthy = false;
    const store = flaky(() => (healthy ? "ok" : "down"));
    const files = await Effect.runPromise(
      resilient(store.files, { ...FAST, retries: 0, breakerThreshold: 2 }),
    );
    await failureOf(files.read("a.json"));
    await failureOf(files.read("a.json"));
    const spent = store.calls.length;
    const refused = await failureOf(files.read("a.json"));
    expect(refused).toMatchObject({ _tag: "SecretFsUnavailable" });
    expect(store.calls.length).toBe(spent);

    healthy = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await Effect.runPromise(files.write("a.json", bytes("back")));
    expect(store.calls.length).toBe(spent + 1);
    await Effect.runPromise(files.read("a.json"));
    expect(store.calls.length).toBe(spent + 2);
  });

  it("keeps a circuit open when the probe fails too", async () => {
    const store = flaky(() => "down");
    const files = await Effect.runPromise(
      resilient(store.files, { ...FAST, retries: 0, breakerThreshold: 1 }),
    );
    await failureOf(files.read("a.json"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await failureOf(files.read("a.json"));
    const spent = store.calls.length;
    await failureOf(files.read("a.json"));
    expect(store.calls.length).toBe(spent);
  });
});
