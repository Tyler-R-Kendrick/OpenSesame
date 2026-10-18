import { subscribeDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { localVaultSessionGuard } from "@opensesame/app-core/lib/secret-backends/local-vault-port.js";
import type {
  TailscaleBrowserNode,
  TailscaleNativeHTTPPort,
  TailscaleNodeConfiguration,
  TailscaleNodeSnapshot,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  type TailscaleNodeRecord,
  type TailscaleNodeState,
  browserNodeCredentialFingerprint,
  browserNodePublicFingerprint,
  forgetBrowserNodeState,
  openBrowserNodeState,
  writeBrowserNodeState,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import artifacts from "../../../lib/capabilities/tailscale-artifacts.json";
import {
  type BrowserNodePolicy,
  browserNodeControlURL,
} from "./browser-node-policy.js";
import {
  BrowserNodeRequests,
  nativeWorkerOptions,
} from "./controller-requests.js";
import { Configuration, HostMessage, NetMap } from "./protocol.js";
export type { BrowserNodePolicy } from "./browser-node-policy.js";
const stopped = (): TailscaleNodeSnapshot => ({
  status: "stopped",
  hostname: "",
  controlURL: "",
  authURL: "",
  addresses: [],
  peerCount: 0,
  failure: "",
});
export function createBrowserNodeController(
  policy: BrowserNodePolicy,
): TailscaleBrowserNode {
  return new BrowserNodeController(policy);
}
class BrowserNodeController implements TailscaleBrowserNode {
  private view = stopped();
  private listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private turn = 0;
  private session: ReturnType<typeof localVaultSessionGuard> | null = null;
  private record: TailscaleNodeRecord | null = null;
  private connectionId = "";
  private expectedPublic = "";
  private expected: TailscaleNodeState = {};
  private expectedCredential = "";
  private writes: Promise<void> = Promise.resolve();
  private writing = 0;
  private releaseVault: (() => void) | null = null;
  private releaseRows: (() => void) | null = null;
  private running = false;
  private authorized = false;
  private requests: BrowserNodeRequests | null = null;
  constructor(private readonly policy: BrowserNodePolicy) {}
  snapshot = () => this.view;
  authorization = () => {
    const turn = this.turn;
    const connectionId = this.connectionId;
    if (!connectionId || !this.record || this.writing) return null;
    this.check(turn);
    if (!this.policy.approve(this.record.controlURL, "GET")) return null;
    this.check(turn);
    return { connectionId, connected: this.view.status === "connected" };
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<TailscaleNodeSnapshot>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private check(turn = this.turn): void {
    this.policy.assertCurrent();
    if (turn !== this.turn || !this.session)
      throw new Error("Tailscale node session ended.");
    if (this.session.current().guest)
      throw new Error("Create your own vault first.");
    if (
      this.record &&
      browserNodePublicFingerprint(this.record, this.connectionId) !==
        this.expectedPublic
    )
      throw new Error("The saved Tailscale browser node changed.");
    if (
      this.record &&
      !this.writing &&
      browserNodeCredentialFingerprint(this.record) !== this.expectedCredential
    )
      throw new Error(
        "Tailscale private state changed. Reconnect the browser node.",
      );
  }
  private beginSession(
    input: TailscaleNodeConfiguration,
    url: URL,
    turn: number,
  ): void {
    this.session = localVaultSessionGuard(vaultStore);
    this.check(turn);
    this.publish({
      ...stopped(),
      hostname: input.hostname,
      controlURL: url.origin,
      status: "starting",
    });
  }
  async start(input: TailscaleNodeConfiguration): Promise<void> {
    this.stop();
    const turn = this.turn;
    try {
      this.policy.assertCurrent();
      const url = browserNodeControlURL(input.controlURL);
      this.beginSession(input, url, turn);
      const session = this.session;
      if (!session) throw new Error("Tailscale node session ended.");
      const config = Configuration.parse({
        ...input,
        nativeHTTP: undefined,
        controlURL: url.origin,
        authKey: input.authKey ?? "",
        state: {},
        assets: {
          runtime: new URL(
            `${import.meta.env.BASE_URL}${artifacts.assets.runtime}`,
            location.origin,
          ).href,
          wasm: new URL(
            `${import.meta.env.BASE_URL}${artifacts.assets.wasm}`,
            location.origin,
          ).href,
        },
      });
      const stored = await openBrowserNodeState(
        { ...config, nativeHTTP: input.nativeHTTP },
        session.current().tomb,
        () => this.check(turn),
      );
      this.check(turn);
      if (
        browserNodeCredentialFingerprint(stored.record) !==
          stored.credentialReceipt ||
        browserNodePublicFingerprint(stored.record, stored.connectionId) !==
          stored.publicReceipt
      )
        throw new Error(
          "The saved Tailscale browser node changed during startup.",
        );
      this.record = stored.record;
      this.connectionId = stored.connectionId;
      this.expectedPublic = stored.publicReceipt;
      this.expected = stored.state;
      this.expectedCredential = stored.credentialReceipt;
      const observe = () => {
        try {
          this.check(turn);
        } catch {
          this.fail(turn);
        }
      };
      this.releaseVault = vaultStore.subscribe(observe);
      this.releaseRows = subscribeDeviceRows(observe);
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "opensesame-tailscale",
      });
      this.requests = new BrowserNodeRequests(
        this.worker,
        () => this.check(turn),
        () => this.view.status === "connected" && this.writing === 0,
        (url) => this.policy.approvePeer(url),
        () => this.stop(),
        stored.record.nativeHTTP !== undefined,
      );
      const options = nativeWorkerOptions(
        stored.record.nativeHTTP,
        artifacts.assets,
        new URL(import.meta.env.BASE_URL, location.origin),
      );
      this.worker.onmessage = (event) => this.receive(event.data, turn);
      this.worker.onerror = () => this.fail(turn);
      this.worker.postMessage({
        kind: "start",
        config: {
          ...config,
          state: stored.state,
          nativeHTTP: options.nativeHTTP,
          assets: {
            ...config.assets,
            ...options.asset,
          },
        },
      });
    } catch (error) {
      if (turn === this.turn) {
        this.stop();
        this.publish({
          status: "error",
          failure:
            error instanceof Error
              ? error.message
              : "Could not start the browser node.",
        });
      }
      throw error;
    }
  }
  private receive(raw: BoundaryValue, turn: number) {
    if (turn !== this.turn) return;
    const parsed = HostMessage.safeParse(raw);
    if (!parsed.success) {
      this.fail(turn);
      return;
    }
    const message = parsed.data;
    if (message.kind === "storage") {
      this.persist(message.state, turn);
      return;
    }
    void this.writes
      .then(() => {
        this.check(turn);
        this.apply(message, turn);
      })
      .catch(() => this.fail(turn));
  }
  private persist(next: TailscaleNodeState, turn: number) {
    this.writes = this.writes.then(async () => {
      this.check(turn);
      if (!this.record) throw new Error("Browser node credential is missing.");
      const record = this.record;
      const state = { ...next };
      this.writing++;
      this.publish({});
      try {
        const receipt = await writeBrowserNodeState(
          record,
          this.expected,
          state,
          () => this.check(turn),
        );
        this.check(turn);
        if (
          this.record !== record ||
          browserNodeCredentialFingerprint(record) !== receipt
        )
          throw new Error("Tailscale private state changed after persistence.");
        this.expected = state;
        this.expectedCredential = receipt;
      } finally {
        if (turn === this.turn) {
          this.writing--;
          this.publish({});
        }
      }
      this.check(turn);
    });
    void this.writes.catch(() => this.fail(turn));
  }
  private apply(
    message: ReturnType<typeof HostMessage.parse>,
    turn: number,
  ): void {
    if (this.requests?.receive(message)) return;
    if (message.kind === "decision") {
      const url = new URL(message.url);
      // Optional upstream diagnostic uploads never leave this PWA.
      const allowed =
        url.hostname !== "log.tailscale.com" &&
        this.policy.approve(url.href, message.method);
      this.check(turn);
      this.worker?.postMessage({ kind: "decision", id: message.id, allowed });
    } else if (message.kind === "state") {
      this.running = message.state === "Running";
      if (message.state === "NeedsLogin") this.publish({ status: "login" });
      else if (message.state === "NeedsMachineAuth")
        this.publish({ status: "approval" });
      this.connected();
    } else if (message.kind === "netmap") {
      const map = NetMap.parse(JSON.parse(message.value));
      this.authorized =
        !map.lockedOut && map.self.machineStatus === "MachineAuthorized";
      this.publish({
        addresses: map.self.addresses,
        peerCount: map.peers.length,
      });
      this.connected();
    } else if (message.kind === "auth") this.authorize(message.url);
    else if (message.kind === "error") this.fail(turn);
  }
  private connected() {
    if (this.running && this.authorized && this.view.addresses.length > 0)
      this.publish({ status: "connected", authURL: "" });
    else if (this.view.status === "connected")
      this.publish({ status: "starting", addresses: [] });
  }
  private authorize(href: string) {
    const url = new URL(href);
    const control = new URL(this.view.controlURL);
    if (
      url.username ||
      url.password ||
      (url.origin !== control.origin &&
        !(
          control.hostname === "controlplane.tailscale.com" &&
          url.origin === "https://login.tailscale.com"
        ))
    )
      throw new Error("Unexpected Tailscale authorization destination.");
    this.publish({ status: "login", authURL: url.href });
  }
  async forget(): Promise<void> {
    this.stop();
    this.policy.assertCurrent();
    const session = localVaultSessionGuard(vaultStore);
    try {
      const check = () => {
        this.policy.assertCurrent();
        session.current();
      };
      await forgetBrowserNodeState(session.current().tomb, check);
    } finally {
      session.close();
    }
  }
  login(): void {
    this.check();
    this.worker?.postMessage({ kind: "login" });
  }
  captureNativeHTTP(owner: AbortSignal): TailscaleNativeHTTPPort {
    this.check();
    if (!this.requests)
      throw new Error("Connect the original browser node first.");
    return this.requests.capture(owner);
  }
  get(url: string): Promise<{ status: number; text: string }> {
    this.check();
    if (!this.requests)
      return Promise.reject(new Error("Connect a browser node first."));
    return this.requests.get(url);
  }
  private fail(turn: number) {
    if (turn !== this.turn) return;
    this.stop();
    this.publish({
      status: "error",
      failure:
        "The Tailscale browser node stopped. Check network access and reconnect.",
    });
  }
  stop(): void {
    this.turn++;
    this.requests?.close();
    this.requests = null;
    this.worker?.terminate();
    this.worker = null;
    this.releaseVault?.();
    this.releaseVault = null;
    this.releaseRows?.();
    this.releaseRows = null;
    this.session?.close();
    this.session = null;
    this.record = null;
    this.connectionId = "";
    this.expectedPublic = "";
    this.expected = {};
    this.expectedCredential = "";
    this.writing = 0;
    this.writes = Promise.resolve();
    this.running = false;
    this.authorized = false;
    this.publish(stopped());
  }
}
