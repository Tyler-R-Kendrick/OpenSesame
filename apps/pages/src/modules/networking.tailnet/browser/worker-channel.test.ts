/** @vitest-environment node */
// The Worker's own channel reaches anything that holds the Worker object, so
// after `start` the node takes its commands only on the port start transferred.
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Configuration, type HostEvent } from "./protocol.js";
import type { loadBrowserNode } from "./sdk.js";
import type { installWorkerEgress } from "./worker-egress.js";
import type { BrowserNodeWorker } from "./worker.js";

const config = Configuration.parse({
  hostname: "channel-worker",
  controlURL: "https://control.example",
  authKey: "",
  state: {},
  assets: {
    runtime: "https://app.example/runtime.js",
    wasm: "https://app.example/node.gz",
  },
});
const refused = "https://refused.example/";
const client = {
  run: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  fetch: vi.fn(),
};
const loader = vi.fn<typeof loadBrowserNode>();
const egress = vi.fn<typeof installWorkerEgress>();
let sent: HostEvent[];
let driver: BrowserNodeWorker;
let ports: MessageChannel;
/** What anything holding the Worker object can post. */
function forge(data: BoundaryValue) {
  driver.receive(new MessageEvent("message", { data }));
}
async function load() {
  const { BrowserNodeWorker } = await import("./worker.js");
  driver = new BrowserNodeWorker((message) => sent.push(message), {
    load: loader,
    egress,
  });
  ports = new MessageChannel();
  driver.receive(
    new MessageEvent("message", {
      data: { kind: "start", config },
      ports: [ports.port2],
    }),
  );
  await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
  const [[decide]] = egress.mock.calls;
  return decide;
}
beforeEach(() => {
  vi.resetModules();
  sent = [];
  client.run.mockReset();
  client.login.mockReset();
  loader.mockReset().mockResolvedValue(client);
  egress.mockReset();
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("postMessage", vi.fn());
});
afterEach(() => {
  ports.port1.close();
  vi.unstubAllGlobals();
});

it("takes an egress decision only on the start port, for the request it names", async () => {
  const decide = await load();
  const decided = decide(refused, "GET");
  expect(sent).toEqual([
    { kind: "decision", id: 1, url: refused, method: "GET" },
  ]);
  forge({ kind: "decision", id: 1, allowed: true });
  ports.port1.postMessage({
    kind: "decision",
    id: 1,
    url: "https://allowed.example/",
    method: "GET",
    allowed: true,
  });
  ports.port1.postMessage({
    kind: "decision",
    id: 1,
    url: refused,
    method: "GET",
    allowed: false,
  });
  await expect(decided).resolves.toBe(false);
  const allowed = decide(refused, "POST");
  ports.port1.postMessage({
    kind: "decision",
    id: 2,
    url: refused,
    method: "POST",
    allowed: true,
  });
  await expect(allowed).resolves.toBe(true);
});

it("acts on no command posted on the Worker's own channel", async () => {
  await load();
  forge({ kind: "login" });
  forge({ kind: "closeHTTP" });
  forge({ kind: "nativeHTTPReady" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(client.login).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
  ports.port1.postMessage({ kind: "login" });
  await vi.waitFor(() => expect(client.login).toHaveBeenCalledTimes(1));
});

it("starts only with exactly one transferred port, and replies only on it", async () => {
  const { BrowserNodeWorker } = await import("./worker.js");
  driver = new BrowserNodeWorker((message) => sent.push(message), {
    load: loader,
    egress,
  });
  ports = new MessageChannel();
  forge({ kind: "start", config });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(loader).not.toHaveBeenCalled();
  expect(driver.channel).toBeNull();
  driver.receive(
    new MessageEvent("message", {
      data: { kind: "start", config },
      ports: [ports.port2],
    }),
  );
  expect(driver.channel).toBe(ports.port2);
  await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
});
