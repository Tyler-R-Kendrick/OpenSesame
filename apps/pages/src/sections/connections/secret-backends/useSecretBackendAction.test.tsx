/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  type PropsWithChildren,
  Suspense,
  startTransition,
  useLayoutEffect,
} from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type SecretBackendActionOwner,
  useSecretBackendAction,
} from "./useSecretBackendAction.js";

afterEach(cleanup);
function deferred() {
  let resolve: (value: string | undefined) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<string | undefined>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function pending() {
  const reply = deferred();
  const owners: SecretBackendActionOwner[] = [];
  const action = vi.fn((owner: SecretBackendActionOwner) => {
    owners.push(owner);
    return reply.promise;
  });
  const owner = () => {
    const value = owners[0];
    if (!value) throw new Error("Expected an admitted action context");
    return value;
  };
  return { reply, owners, action, owner };
}
type HookState = ReturnType<typeof useSecretBackendAction>;
function begin(
  view: { result: { current: HookState } },
  action: Parameters<HookState["run"]>[0],
) {
  let task = Promise.resolve(false);
  act(() => {
    task = view.result.current.run(action);
  });
  return task;
}
function setup(signal?: AbortSignal) {
  const flash = vi.fn();
  const view = renderHook(
    ({ signal }) => useSecretBackendAction(flash, signal),
    { initialProps: { signal } },
  );
  return { ...view, flash };
}

it.each(["Saved", undefined])(
  "preserves zero-argument success with %s and stable methods",
  async (message) => {
    const view = setup();
    const { run, clear } = view.result.current;
    const action = vi.fn(async () => message);
    await act(async () => {
      expect(await run(action)).toBe(true);
    });
    expect(view.result.current.result).toBe(message ?? "");
    expect(view.result.current.busy).toBe(false);
    expect(view.flash).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledOnce();
    view.rerender({ signal: undefined });
    expect(view.result.current.run).toBe(run);
    expect(view.result.current.clear).toBe(clear);
  },
);

it("reports an ordinary failure and ends only the short action controller", async () => {
  const external = new AbortController();
  const view = setup(external.signal);
  const first = pending();
  const task = begin(view, first.action);
  expect(first.owner().current()).toBe(true);
  first.owner().check();
  await act(async () => {
    first.reply.reject(new Error("Ordinary failure"));
    expect(await task).toBe(false);
  });
  expect(view.result.current.failure).toBe("Ordinary failure");
  expect(view.flash).toHaveBeenCalledExactlyOnceWith({
    tone: "err",
    text: "Ordinary failure",
  });
  expect(first.owner().signal.aborted).toBe(true);
  expect(external.signal.aborted).toBe(false);
  await act(async () => {
    expect(await view.result.current.run(async () => "Recovered")).toBe(true);
  });
  expect(view.result.current.failure).toBe("");
  expect(view.result.current.result).toBe("Recovered");
});

it("refuses duplicates while an exact action owns pending state", async () => {
  const view = setup();
  const first = pending();
  const task = begin(view, first.action);
  const duplicate = vi.fn(async () => "duplicate");
  await act(async () => {
    expect(await view.result.current.run(duplicate)).toBe(false);
  });
  expect(duplicate).not.toHaveBeenCalled();
  expect(view.result.current.busy).toBe(true);
  await act(async () => {
    first.reply.resolve("First");
    expect(await task).toBe(true);
  });
  expect(view.result.current.result).toBe("First");
});

it.each(["resolve", "reject"] as const)(
  "clear cancels immediately and ignores late %s",
  async (late) => {
    const view = setup();
    const first = pending();
    const task = begin(view, first.action);
    await act(async () => {
      view.result.current.clear();
      expect(await task).toBe(false);
    });
    expect(first.owner().signal.aborted).toBe(true);
    expect(first.owner().current()).toBe(false);
    expect(() => first.owner().check()).toThrow("This action ended.");
    expect(view.result.current.busy).toBe(false);
    await act(async () => {
      if (late === "resolve") first.reply.resolve("Stale success");
      else first.reply.reject(new Error("Stale failure"));
    });
    expect(view.result.current.result).toBe("");
    expect(view.result.current.failure).toBe("");
    expect(view.flash).not.toHaveBeenCalled();
  },
);

it.each(["resolve", "reject"] as const)(
  "unmount aborts before late %s and saved methods cannot restart work",
  async (late) => {
    const view = setup();
    const first = pending();
    const task = begin(view, first.action);
    const { run, clear } = view.result.current;
    view.unmount();
    expect(first.owner().signal.aborted).toBe(true);
    expect(await task).toBe(false);
    const action = vi.fn(async () => "Should not run");
    clear();
    expect(await run(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
    if (late === "resolve") first.reply.resolve("Late success");
    else first.reply.reject(new Error("Late failure"));
    await Promise.resolve();
    expect(view.flash).not.toHaveBeenCalled();
    const next = setup();
    await act(async () => {
      expect(await next.result.current.run(async () => "Fresh mount")).toBe(
        true,
      );
    });
    expect(next.result.current.result).toBe("Fresh mount");
  },
);

it("creates usable fresh epochs during StrictMode effect replay", async () => {
  const work = pending();
  const tasks: Promise<boolean>[] = [];
  const flash = vi.fn();
  const view = renderHook(
    () => {
      const hook = useSecretBackendAction(flash);
      useLayoutEffect(() => {
        tasks.push(hook.run(work.action));
      }, [hook.run]);
      return hook;
    },
    { reactStrictMode: true },
  );
  expect(work.owners).toHaveLength(2);
  expect(work.owners[0]?.signal.aborted).toBe(true);
  expect(work.owners[1]?.current()).toBe(true);
  await act(async () => {
    work.reply.resolve("Latest epoch");
    expect(await Promise.all(tasks)).toEqual([false, true]);
  });
  expect(view.result.current.result).toBe("Latest epoch");
  expect(view.result.current.busy).toBe(false);
  expect(flash).not.toHaveBeenCalled();
});

it("uses the latest committed flash callback for a pending failure", async () => {
  const old = vi.fn();
  const latest = vi.fn();
  const view = renderHook(({ flash }) => useSecretBackendAction(flash), {
    initialProps: { flash: old },
  });
  const first = pending();
  const task = begin(view, first.action);
  view.rerender({ flash: latest });
  await act(async () => {
    first.reply.reject(new Error("Current failure"));
    expect(await task).toBe(false);
  });
  expect(old).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith({
    tone: "err",
    text: "Current failure",
  });
});

it("does not borrow a callback from a suspended uncommitted render", async () => {
  const committed = vi.fn();
  const speculative = vi.fn();
  const never = new Promise<void>(() => {});
  const wrapper = ({ children }: PropsWithChildren) => (
    <Suspense fallback={null}>{children}</Suspense>
  );
  const view = renderHook(
    ({ flash, suspend }) => {
      const hook = useSecretBackendAction(flash);
      if (suspend) throw never;
      return hook;
    },
    { initialProps: { flash: committed, suspend: false }, wrapper },
  );
  const first = pending();
  const task = begin(view, first.action);
  act(() => {
    startTransition(() => view.rerender({ flash: speculative, suspend: true }));
  });
  expect(first.owner().current()).toBe(true);
  await act(async () => {
    first.reply.reject(new Error("Committed failure"));
    expect(await task).toBe(false);
  });
  expect(speculative).not.toHaveBeenCalled();
  expect(committed).toHaveBeenCalledExactlyOnceWith({
    tone: "err",
    text: "Committed failure",
  });
});

it.each(["clear", "success", "flash"] as const)(
  "keeps reentrant successor pending after old %s retirement",
  async (trigger) => {
    const first = pending();
    const second = pending();
    let successor = Promise.resolve(false);
    const flash = vi.fn(() => {
      view.result.current.clear();
      successor = view.result.current.run(second.action);
    });
    const view = renderHook(() => useSecretBackendAction(flash));
    const task = begin(view, first.action);
    if (trigger !== "flash")
      first.owner().signal.addEventListener("abort", () => {
        successor = view.result.current.run(second.action);
      });
    await act(async () => {
      if (trigger === "clear") view.result.current.clear();
      else if (trigger === "success") first.reply.resolve("Old success");
      else first.reply.reject(new Error("Old failure"));
      expect(await task).toBe(trigger === "success");
    });
    expect(second.action).toHaveBeenCalledOnce();
    expect(view.result.current.busy).toBe(true);
    expect(view.result.current.result).toBe("");
    expect(view.result.current.failure).toBe("");
    expect(second.owner().current()).toBe(true);
    await act(async () => {
      first.reply.resolve("Stale first");
      expect(await view.result.current.run(async () => "Duplicate")).toBe(
        false,
      );
    });
    expect(view.result.current.busy).toBe(true);
    await act(async () => {
      second.reply.resolve("Second");
      expect(await successor).toBe(true);
    });
    expect(view.result.current.result).toBe("Second");
  },
);

it("refuses already-ended owners without publishing failure or calling the body", async () => {
  const view = setup(AbortSignal.abort("private reason"));
  const action = vi.fn(async () => "No authority");
  await act(async () => {
    expect(await view.result.current.run(action)).toBe(false);
  });
  expect(action).not.toHaveBeenCalled();
  expect(view.result.current.busy).toBe(false);
  expect(view.result.current.failure).toBe("");
  expect(view.flash).not.toHaveBeenCalled();
});

it("cancels a hung action on external withdrawal without aborting its supplied owner", async () => {
  const external = new AbortController();
  const view = setup(external.signal);
  const first = pending();
  const remove = vi.spyOn(external.signal, "removeEventListener");
  const task = begin(view, first.action);
  await act(async () => {
    external.abort("private reason");
    expect(await task).toBe(false);
  });
  expect(first.owner().signal.aborted).toBe(true);
  expect(view.result.current.busy).toBe(false);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(view.flash).not.toHaveBeenCalled();
});

it("cancels only the replaced owner and detaches its listener before the next action", async () => {
  const old = new AbortController();
  const next = new AbortController();
  const view = setup(old.signal);
  const first = pending();
  const oldTask = begin(view, first.action);
  view.rerender({ signal: next.signal });
  expect(await oldTask).toBe(false);
  const second = pending();
  const nextTask = begin(view, second.action);
  act(() => old.abort());
  expect(second.owner().current()).toBe(true);
  expect(next.signal.aborted).toBe(false);
  await act(async () => {
    first.reply.reject(new Error("Old owner failure"));
    second.reply.resolve("New owner");
    expect(await nextTask).toBe(true);
  });
  expect(view.result.current.result).toBe("New owner");
  expect(view.flash).not.toHaveBeenCalled();
});

it("ends only its short controller after success and preserves the retained supplied lifetime", async () => {
  const external = new AbortController();
  const view = setup(external.signal);
  const first = pending();
  const task = begin(view, first.action);
  await act(async () => {
    first.reply.resolve("Connected");
    expect(await task).toBe(true);
  });
  expect(first.owner().signal.aborted).toBe(true);
  expect(first.owner().current()).toBe(false);
  expect(external.signal.aborted).toBe(false);
  await act(async () => {
    expect(await view.result.current.run(async () => "Still live")).toBe(true);
  });
  expect(external.signal.aborted).toBe(false);
});

it.each(["subscription", "publication"] as const)(
  "refuses positive delivery when the owner ends during %s",
  async (timing) => {
    const external = new AbortController();
    const work = deferred();
    const action = vi.fn(() => work.promise);
    if (timing === "subscription") {
      const add = external.signal.addEventListener.bind(external.signal);
      vi.spyOn(external.signal, "addEventListener").mockImplementation(
        (...args) => {
          add(...args);
          external.abort();
        },
      );
    } else void work.promise.then(() => queueMicrotask(() => external.abort()));
    const view = setup(external.signal);
    const task = begin(view, action);
    await act(async () => {
      work.resolve("Must not publish");
      expect(await task).toBe(false);
    });
    expect(action).toHaveBeenCalledTimes(timing === "subscription" ? 0 : 1);
    expect(view.result.current.result).toBe("");
    expect(view.flash).not.toHaveBeenCalled();
  },
);
