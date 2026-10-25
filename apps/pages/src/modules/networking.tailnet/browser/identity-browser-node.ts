import type {
  IdentityBrowserNode,
  IdentityBrowserNodeConfiguration,
  IdentityBrowserNodeOwner,
  IdentityHTTPPort,
} from "@opensesame/app-core/lib/tailscale/browser-node-identity-port.js";
/** One explicit enrollment uses the official SDK in its own disposable, memory-only Worker. */
import type { TailscaleNodeSnapshot } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { z } from "zod";
import {
  type BrowserNodePolicy,
  browserNodeControlURL,
} from "./browser-node-policy.js";
import {
  BrowserNodeRequests,
  nativeWorkerOptions,
} from "./controller-requests.js";
import {
  Configuration,
  type HostEvent,
  HostMessage,
  NetMap,
  type WorkerCommand,
} from "./protocol.js";
import type { BrowserNodeAssets } from "./sdk.js";
export type IdentityNodePolicy = BrowserNodePolicy &
  Readonly<{ approveNative: (href: string, method: string) => boolean }>;
export type IdentityWorker = {
  postMessage: (message: WorkerCommand, ports: MessagePort[]) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};
const stopped = (): TailscaleNodeSnapshot => ({
  status: "stopped",
  hostname: "",
  controlURL: "",
  authURL: "",
  addresses: [],
  peerCount: 0,
  failure: "",
});
const IdentityMap = NetMap.and(
  z.object({
    self: z.object({
      machineKey: z.string().min(1).max(1024),
      nodeKey: z.string().min(1).max(1024),
    }),
  }),
);
export class MemoryIdentityBrowserNode implements IdentityBrowserNode {
  private view = stopped();
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private worker: IdentityWorker | null = null;
  private channel: MessagePort | null = null;
  private requests: BrowserNodeRequests | null = null;
  private closing: Promise<boolean> | null = null;
  private closed: ((acknowledged: boolean) => void) | null = null;
  private started = false;
  private running = false;
  private authorized = false;
  private loginRequested = false;
  private originalSelf = "";
  private origins = new Set<string>();
  private readonly policyMethods: IdentityNodePolicy;
  constructor(
    private readonly owner: IdentityBrowserNodeOwner,
    private readonly policy: IdentityNodePolicy,
    private readonly assets: BrowserNodeAssets,
    private readonly makeWorker: () => IdentityWorker = () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "opensesame-identity-peering",
      }),
  ) {
    this.policyMethods = {
      assertCurrent: policy.assertCurrent,
      approve: policy.approve,
      approvePeer: policy.approvePeer,
      approveNative: policy.approveNative,
    };
    owner.signal.addEventListener("abort", this.abort, { once: true });
  }
  private abort = () => {
    void this.stop();
  };
  private check = () => {
    this.lifetime.signal.throwIfAborted();
    this.owner.signal.throwIfAborted();
    this.owner.assertCurrent();
    this.assertPolicy();
    this.policyMethods.assertCurrent.call(this.policy);
    this.assertPolicy();
    this.lifetime.signal.throwIfAborted();
    this.owner.signal.throwIfAborted();
  };
  private assertPolicy = () => {
    const original = this.policyMethods;
    if (
      this.policy.assertCurrent !== original.assertCurrent ||
      this.policy.approve !== original.approve ||
      this.policy.approvePeer !== original.approvePeer ||
      this.policy.approveNative !== original.approveNative
    )
      throw new Error("Original identity peering policy changed.");
  };
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<TailscaleNodeSnapshot>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private connected = () => this.view.status === "connected";
  start(input: IdentityBrowserNodeConfiguration): void {
    this.check();
    if (this.started)
      throw new Error("The original identity peering attempt already started.");
    this.started = true;
    try {
      const control = browserNodeControlURL(input.controlURL);
      if (!this.policyMethods.approve.call(this.policy, control.href, "GET"))
        throw new Error("Approve Networking for this control server first.");
      this.check();
      if (!input.nativeHTTP)
        throw new Error(
          "Configure native HTTPS routing and trust for this identity attempt.",
        );
      const options = nativeWorkerOptions(
        input.nativeHTTP,
        this.assets,
        new URL(this.assets.runtime),
      );
      const config = Configuration.parse({
        hostname: `opensesame-id-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        controlURL: control.origin,
        authKey: "",
        state: {},
        ephemeral: true,
        assets: { ...this.assets, ...options.asset },
        nativeHTTP: options.nativeHTTP,
      });
      if (!config.nativeHTTP)
        throw new Error("Original native HTTPS route is unavailable.");
      this.origins = new Set(
        config.nativeHTTP.targets.map((target) => target.origin),
      );
      this.check();
      const worker = this.makeWorker();
      this.worker = worker;
      const channel = new MessageChannel();
      this.channel = channel.port1;
      this.requests = new BrowserNodeRequests(
        channel.port1,
        this.check,
        this.connected,
        (href) => this.policyMethods.approvePeer.call(this.policy, href),
        this.abort,
        true,
      );
      channel.port1.onmessage = (event) => this.receive(event);
      worker.onerror = () => this.fail();
      this.publish({
        ...stopped(),
        hostname: config.hostname,
        controlURL: control.origin,
        status: "starting",
      });
      this.check();
      worker.postMessage({ kind: "start", config }, [channel.port2]);
    } catch (error) {
      this.fail();
      throw error;
    }
  }
  private receive(event: MessageEvent): void {
    try {
      const message = HostMessage.parse(event.data);
      // Original HTTP retirement acknowledgement must still settle after authority withdrawal.
      if (message.kind === "closeHTTP") {
        this.closed?.(message.closed);
        return;
      }
      if (this.lifetime.signal.aborted) return;
      this.check();
      if (this.requests?.receive(message)) return;
      this.apply(message);
    } catch {
      this.fail();
    }
  }
  private apply(message: HostEvent): void {
    if (message.kind === "decision") {
      const destination = new URL(message.url);
      const allowed =
        destination.hostname !== "log.tailscale.com" &&
        this.policyMethods.approve.call(
          this.policy,
          destination.href,
          message.method,
        );
      this.check();
      this.channel?.postMessage({
        kind: "decision",
        id: message.id,
        url: message.url,
        method: message.method,
        allowed,
      });
    } else if (message.kind === "state") {
      if (this.connected() && message.state !== "Running")
        throw new Error("Original identity browser node stopped.");
      this.running = message.state === "Running";
      if (message.state === "NeedsLogin") this.publish({ status: "login" });
      else if (message.state === "NeedsMachineAuth")
        this.publish({ status: "approval" });
      this.updateConnected();
    } else if (message.kind === "netmap") this.netmap(message.value);
    else if (message.kind === "auth") this.authorize(message.url);
    else if (message.kind === "error" || message.kind === "storage")
      this.fail();
  }
  private netmap(value: string): void {
    const map = IdentityMap.parse(JSON.parse(value));
    const self = JSON.stringify([map.self.machineKey, map.self.nodeKey]);
    if (this.originalSelf && this.originalSelf !== self)
      throw new Error("Original identity browser node changed.");
    this.originalSelf = self;
    this.authorized =
      !map.lockedOut && map.self.machineStatus === "MachineAuthorized";
    if (!this.authorized && this.connected())
      throw new Error("Original identity browser node lost authorization.");
    this.publish({
      addresses: map.self.addresses,
      peerCount: map.peers.length,
    });
    this.updateConnected();
  }
  private updateConnected(): void {
    if (this.running && this.authorized && this.view.addresses.length > 0)
      this.publish({ status: "connected", authURL: "" });
    else if (this.connected()) this.fail();
  }
  private authorize(href: string): void {
    const url = new URL(href);
    const control = new URL(this.view.controlURL);
    const official =
      control.hostname === "controlplane.tailscale.com" &&
      url.origin === "https://login.tailscale.com";
    if (
      url.username ||
      url.password ||
      (url.origin !== control.origin && !official)
    )
      throw new Error("Unexpected identity peering authorization destination.");
    this.publish({ status: "login", authURL: url.href });
  }
  login(): void {
    this.check();
    if (!this.worker || this.view.status !== "login" || this.loginRequested)
      throw new Error(
        "Start a fresh identity peering attempt before explicit login.",
      );
    this.loginRequested = true;
    this.channel?.postMessage({ kind: "login" });
  }
  captureNativeHTTP(caller: AbortSignal): IdentityHTTPPort {
    this.check();
    if (!this.requests)
      throw new Error("Start the original identity browser node first.");
    const port = this.requests.capture(
      AbortSignal.any([caller, this.owner.signal, this.lifetime.signal]),
    );
    const allowed = (href: string, method: string) => {
      this.check();
      port.assertCurrent();
      const url = new URL(href);
      const permitted =
        this.origins.has(url.origin) &&
        this.policyMethods.approveNative.call(this.policy, url.href, method);
      this.check();
      port.assertCurrent();
      return permitted;
    };
    return Object.freeze({
      signal: port.signal,
      assertCurrent: port.assertCurrent,
      supportsNativeOrigin: (origin) =>
        new URL(origin).origin === origin && allowed(origin, "GET"),
      fetch: (input, init) => {
        // Admission precedes foreign body/header getters; recheck the immutable Request afterward.
        const href = input instanceof Request ? input.url : input.toString();
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (!allowed(href, method.toUpperCase()))
          throw new Error(
            "Approve this original native identity endpoint before sending.",
          );
        const request = new Request(input, init);
        if (!allowed(request.url, request.method))
          throw new Error(
            "Approve this original native identity endpoint before sending.",
          );
        return port.fetch(request);
      },
    });
  }
  private fail(): void {
    void this.stop();
    this.publish({
      status: "error",
      failure:
        "Identity peering ended. Start sign-in again with a fresh browser node.",
    });
  }
  stop(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.owner.signal.removeEventListener("abort", this.abort);
    const worker = this.worker;
    this.closing = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 30000);
      this.closed = (acknowledged) => {
        clearTimeout(timer);
        resolve(acknowledged);
      };
      if (!worker || !this.requests) this.closed(true);
      else this.requests.close();
    }).finally(() => {
      worker?.terminate();
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
      }
      this.channel?.close();
      this.channel = null;
      this.worker = null;
      this.requests = null;
      this.closed = null;
      this.origins.clear();
      this.publish({
        ...stopped(),
        failure: this.view.failure,
        status: this.view.status === "error" ? "error" : "stopped",
      });
    });
    return this.closing;
  }
}
