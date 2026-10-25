/** @vitest-environment node */
// SDK-boundary controls; real Go/WASM enrollment is a separate acceptance gate.
import { afterEach, expect, it, vi } from "vitest";
import {
  Configuration,
  type HostEvent,
  type WorkerCommand,
} from "./protocol.js";
import type { BrowserNodeClient, BrowserNodeConfiguration } from "./sdk.js";

const input = {
  hostname: "memory-identity",
  controlURL: "https://control.example.test",
  authKey: "",
  state: {},
  assets: {
    runtime: "https://app.example.test/runtime.js",
    wasm: "https://app.example.test/node.gz",
  },
};
const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("memory-only enrollment refuses saved node keys and auth-key shortcuts while persistent configuration remains compatible", () => {
  expect(Configuration.parse(input).ephemeral).toBe(false);
  expect(Configuration.parse({ ...input, ephemeral: true }).ephemeral).toBe(
    true,
  );
  expect(
    Configuration.safeParse({ ...input, ephemeral: true, authKey: "not-used" })
      .success,
  ).toBe(false);
  expect(
    Configuration.safeParse({
      ...input,
      ephemeral: true,
      state: { privateNodeKey: "not-used" },
    }).success,
  ).toBe(false);
  expect(
    Configuration.parse({ ...input, state: { existing: "retained" } }).state
      .existing,
  ).toBe("retained");
});
it.each([false, true])(
  "ephemeral=%s keeps SDK state inside its original Worker and requires explicit login",
  async (ephemeral) => {
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("postMessage", vi.fn());
    const sent: HostEvent[] = [];
    const login = vi.fn();
    const run = vi.fn<BrowserNodeClient["run"]>((callbacks) =>
      callbacks.notifyState("NeedsLogin"),
    );
    const client: BrowserNodeClient = {
      login,
      run,
      logout: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error("No peer request")),
    };
    const load = vi.fn(async (configuration: BrowserNodeConfiguration) => {
      configuration.stateStorage.setState("private-node-state", "worker-only");
      return client;
    });
    const { BrowserNodeWorker } = await import("./worker.js");
    const driver = new BrowserNodeWorker((message) => sent.push(message), {
      load,
      egress: vi.fn(),
    });
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    const send = (data: WorkerCommand) => {
      if (data.kind === "start")
        driver.receive(
          new MessageEvent("message", { data, ports: [channel.port2] }),
        );
      else channel.port1.postMessage(data);
    };
    send({
      kind: "start",
      config: Configuration.parse({ ...input, ephemeral }),
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
    expect(
      load.mock.calls[0]?.[0].stateStorage.getState("private-node-state"),
    ).toBe("worker-only");
    expect(sent.filter((message) => message.kind === "storage")).toHaveLength(
      ephemeral ? 0 : 1,
    );
    expect(login).not.toHaveBeenCalled();
    send({ kind: "login" });
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    send({ kind: "closeHTTP" });
    await vi.waitFor(() =>
      expect(sent).toContainEqual({ kind: "closeHTTP", closed: true }),
    );
  },
);
