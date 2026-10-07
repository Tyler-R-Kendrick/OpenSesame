import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelContextApi,
  Unregister,
  WebMcpToolDescriptor,
} from "./detect.js";
import { type WebMcpToolSpec, createWebMcpRegistrar } from "./registrar.js";

const cleanup: Unregister[] = [];
afterEach(() => {
  for (const unregister of cleanup.splice(0)) unregister();
});

type BrowserMode = "registerTool" | "provideContext";

/** Faithful browser registration ports; execution always uses the SDK descriptor. */
function browser(mode: BrowserMode) {
  const tools = new Map<string, WebMcpToolDescriptor>();
  const api: ModelContextApi =
    mode === "registerTool"
      ? {
          registerTool(tool, options) {
            tools.set(tool.name, tool);
            options?.signal.addEventListener("abort", () => {
              if (tools.get(tool.name) === tool) tools.delete(tool.name);
            });
            return undefined;
          },
          unregisterTool(name) {
            tools.delete(name);
            return undefined;
          },
        }
      : {
          provideContext(context) {
            tools.clear();
            for (const tool of context.tools ?? []) tools.set(tool.name, tool);
            return undefined;
          },
        };
  const registrar = createWebMcpRegistrar(api, { appId: "lifetime-fixture" });
  return {
    register(tool: WebMcpToolSpec) {
      const unregister = registrar.register([tool]);
      cleanup.push(unregister);
      const descriptor = tools.get(tool.name);
      if (!descriptor) throw new Error("Actual SDK descriptor not registered.");
      return { descriptor, unregister };
    },
    tools,
  };
}

function spec(
  execute: WebMcpToolSpec["execute"],
  name = "opensesame_status",
): WebMcpToolSpec {
  return {
    name,
    description: "Controlled public status",
    inputSchema: {},
    execute,
  };
}

function deferredValue() {
  let finish: (value: BoundaryValue) => void = () => {
    throw new Error("Deferred not initialized.");
  };
  const promise = new Promise<BoundaryValue>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

const retired = {
  isError: true,
  content: [{ type: "text", text: "registration_retired" }],
};

describe.each<BrowserMode>(["registerTool", "provideContext"])(
  "%s execution lifetime",
  (mode) => {
    it("refuses a retained descriptor before execution while a fresh registration still works", async () => {
      const host = browser(mode);
      const execute = vi.fn(() => ({ status: "current-ready" }));
      const old = host.register(spec(execute));
      await expect(old.descriptor.execute({})).resolves.toEqual({
        content: [{ type: "text", text: '{"status":"current-ready"}' }],
      });
      expect(execute).toHaveBeenCalledTimes(1);
      old.unregister();
      await expect(old.descriptor.execute({})).resolves.toEqual(retired);
      expect(execute).toHaveBeenCalledTimes(1);
      const fresh = host.register(spec(() => ({ status: "fresh-ready" })));
      old.unregister();
      expect(host.tools.get("opensesame_status")).toBe(fresh.descriptor);
      await expect(fresh.descriptor.execute({})).resolves.toEqual({
        content: [{ type: "text", text: '{"status":"fresh-ready"}' }],
      });
    });

    it("withholds a held result after unregister, without disabling the fresh positive control", async () => {
      const host = browser(mode);
      const value = deferredValue();
      const execute = vi.fn(() => value.promise);
      const old = host.register(spec(execute));
      const pending = old.descriptor.execute({});
      expect(execute).toHaveBeenCalledTimes(1);
      try {
        old.unregister();
        const fresh = host.register(spec(() => ({ status: "fresh-ready" })));
        value.finish({ status: "held-old-ready" });
        expect(await pending).toEqual(retired);
        await expect(fresh.descriptor.execute({})).resolves.toEqual({
          content: [{ type: "text", text: '{"status":"fresh-ready"}' }],
        });
      } finally {
        value.finish(null);
        await pending;
      }
    });

    it("withholds an old held result after replacement and ignores its late unregister handle", async () => {
      const host = browser(mode);
      const value = deferredValue();
      const old = host.register(spec(() => value.promise));
      const pending = old.descriptor.execute({});
      try {
        const fresh = host.register(spec(() => ({ status: "fresh-ready" })));
        old.unregister();
        value.finish({ status: "held-old-ready" });
        expect(await pending).toEqual(retired);
        expect(host.tools.get("opensesame_status")).toBe(fresh.descriptor);
        await expect(fresh.descriptor.execute({})).resolves.toEqual({
          content: [{ type: "text", text: '{"status":"fresh-ready"}' }],
        });
      } finally {
        value.finish(null);
        await pending;
      }
    });
    it("passes the original registration ceiling through an awaited tool continuation", async () => {
      const host = browser(mode);
      const value = deferredValue();
      const effect = vi.fn();
      const old = host.register(
        spec(async (_args, assertCurrent) => {
          if (!assertCurrent) throw new Error("Registration ceiling missing.");
          assertCurrent();
          await value.promise;
          assertCurrent();
          effect();
          return { status: "held-old-ready" };
        }),
      );
      const pending = old.descriptor.execute({});
      try {
        old.unregister();
        const freshEffect = vi.fn();
        const fresh = host.register(
          spec((_args, assertCurrent) => {
            if (!assertCurrent)
              throw new Error("Registration ceiling missing.");
            assertCurrent();
            freshEffect();
            return { status: "fresh-ready" };
          }),
        );
        value.finish(null);
        expect(await pending).toEqual(retired);
        expect(effect).not.toHaveBeenCalled();
        await expect(fresh.descriptor.execute({})).resolves.toEqual({
          content: [{ type: "text", text: '{"status":"fresh-ready"}' }],
        });
        expect(freshEffect).toHaveBeenCalledTimes(1);
      } finally {
        value.finish(null);
        await pending;
      }
    });

    it("withholds an old error after its registration is retired", async () => {
      const host = browser(mode);
      const value = deferredValue();
      const old = host.register(
        spec(async () => {
          await value.promise;
          throw new Error("controlled old service failed");
        }),
      );
      const pending = old.descriptor.execute({});
      try {
        old.unregister();
        value.finish(null);
        expect(await pending).toEqual(retired);
      } finally {
        value.finish(null);
        await pending;
      }
    });
  },
);

it("retires the entire previous provideContext even when its replacement uses different names", async () => {
  const host = browser("provideContext");
  const value = deferredValue();
  const old = host.register(spec(() => value.promise));
  const pending = old.descriptor.execute({});
  try {
    const fresh = host.register(
      spec(() => ({ status: "fresh-ready" }), "opensesame_health"),
    );
    value.finish({ status: "held-old-ready" });
    expect(await pending).toEqual(retired);
    old.unregister();
    expect(host.tools.get("opensesame_health")).toBe(fresh.descriptor);
    await expect(fresh.descriptor.execute({})).resolves.toEqual({
      content: [{ type: "text", text: '{"status":"fresh-ready"}' }],
    });
  } finally {
    value.finish(null);
    await pending;
  }
});
