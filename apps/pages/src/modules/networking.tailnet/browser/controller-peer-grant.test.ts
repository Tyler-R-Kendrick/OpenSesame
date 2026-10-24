// @vitest-environment jsdom
// A peer GET is authorized in the page by the egress policy, then carried to
// the worker on a port only that decision holds: the Worker object is reachable
// from the page (`tailscaleBrowserNode()`), so its own channel grants nothing.
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { StatusWorker, netmap } from "./authorization.test-support.js";
import { BrowserNodeRequests } from "./controller-requests.js";
import { createBrowserNodeController } from "./controller.js";

const approved = "http://100.64.0.1/proof";
const config = {
  hostname: "peer-grant",
  controlURL: "https://control.example",
  authKey: "",
  state: {},
  assets: {
    runtime: "https://app.example/runtime.js",
    wasm: "https://app.example/node.gz",
  },
};
class GrantWorker {
  sent: BoundaryValue[] = [];
  ports: MessagePort[] = [];
  postMessage(
    value: BoundaryValue,
    options: Transferable[] | StructuredSerializeOptions = [],
  ) {
    this.sent.push(value);
    const transfer = Array.isArray(options) ? options : options.transfer;
    for (const item of transfer ?? [])
      if (item instanceof MessagePort) this.ports.push(item);
  }
}
function listen(port: MessagePort) {
  const grants: BoundaryValue[] = [];
  port.onmessage = (event: MessageEvent<BoundaryValue>) => {
    grants.push(event.data);
  };
  return grants;
}

it("posts an approved peer GET only on the port it started the worker with", async () => {
  const worker = new GrantWorker();
  const requests = new BrowserNodeRequests(
    worker,
    () => {},
    () => true,
    (url) => url === approved,
    vi.fn(),
    false,
  );
  requests.start(config);
  expect(worker.sent).toEqual([{ kind: "start", config }]);
  expect(worker.ports).toHaveLength(1);
  const grants = listen(worker.ports[0]);
  const pending = requests.get(approved);
  await expect(requests.get("http://100.64.0.9/other")).rejects.toThrow(
    "allow this tailnet service",
  );
  await vi.waitFor(() =>
    expect(grants).toEqual([{ kind: "get", id: 1, url: approved }]),
  );
  expect(worker.sent).toEqual([{ kind: "start", config }]);
  requests.receive({ kind: "get", id: 1, status: 200, text: "proof" });
  await expect(pending).resolves.toEqual({ status: 200, text: "proof" });
  worker.ports[0].close();
});

it("keeps the peer egress decision it was created with", async () => {
  const vault = await runtimeFixture();
  vi.stubGlobal("Worker", StatusWorker);
  const policy = {
    assertCurrent() {},
    approve: (_url: string, _method: string) => true,
    approvePeer: (_url: string) => false,
  };
  const node = createBrowserNodeController(policy);
  try {
    await node.start({
      hostname: "peer-grant",
      controlURL: "https://controlplane.tailscale.com",
    });
    const worker = StatusWorker.current;
    netmap(worker);
    worker.emit({ kind: "state", state: "Running" });
    await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
    policy.approvePeer = () => true;
    const outcome = node.get(approved).then(
      () => "answered",
      (error: Error) => error.message,
    );
    node.stop();
    worker.emit({ kind: "closeHTTP", closed: true });
    expect(await outcome).toContain("allow this tailnet service");
  } finally {
    node.stop();
    vi.unstubAllGlobals();
    await vault.close();
  }
});
