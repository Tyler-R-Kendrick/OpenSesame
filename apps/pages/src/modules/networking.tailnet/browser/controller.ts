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
import { browserNodeTransportOptions } from "@opensesame/app-core/lib/tailscale/browser-node-transport-options.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import artifacts from "../../../lib/capabilities/tailscale-artifacts.json";
import {
  type BrowserNodePolicy,
  browserNodeAuthURL,
  browserNodeControlURL,
} from "./browser-node-policy.js";
import {
  BrowserNodeRequests,
  browserNodeStartConfiguration,
  nativeWorkerOptions,
} from "./controller-requests.js";
import { BrowserNodeRetirement } from "./controller-retirement.js";
import { HostMessage, NetMap } from "./protocol.js";
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
  #view = stopped();
  #listeners = new Set<() => void>();
  #worker: Worker | null = null;
  #turn = 0;
  #session: ReturnType<typeof localVaultSessionGuard> | null = null;
  #record: TailscaleNodeRecord | null = null;
  #connectionId = "";
  #expectedPublic = "";
  #expected: TailscaleNodeState = {};
  #expectedCredential = "";
  #writes: Promise<void> = Promise.resolve();
  #writing = 0;
  #releaseVault: (() => void) | null = null;
  #releaseRows: (() => void) | null = null;
  #running = false;
  #authorized = false;
  #requests: BrowserNodeRequests | null = null;
  readonly #retirement = new BrowserNodeRetirement();
  // Every member is #private: page code holding the node reaches only the
  // TailscaleBrowserNode methods, never the port, a callback over it or the policy.
  readonly #assertCurrent: BrowserNodePolicy["assertCurrent"];
  readonly #approve: BrowserNodePolicy["approve"];
  readonly #approvePeer: BrowserNodePolicy["approvePeer"];
  /** This start's end of the only channel its worker trusts. */
  #port: MessagePort | null = null;
  constructor(policy: BrowserNodePolicy) {
    this.#assertCurrent = policy.assertCurrent;
    this.#approve = policy.approve;
    this.#approvePeer = policy.approvePeer;
  }
  snapshot = () => this.#view;
  authorization = () => {
    const turn = this.#turn;
    const connectionId = this.#connectionId;
    if (!connectionId || !this.#record || this.#writing) return null;
    this.#check(turn);
    if (!this.#approve(this.#record.controlURL, "GET")) return null;
    this.#check(turn);
    return { connectionId, connected: this.#view.status === "connected" };
  };
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish(patch: Partial<TailscaleNodeSnapshot>) {
    this.#view = { ...this.#view, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #check(turn = this.#turn): void {
    this.#assertCurrent();
    if (turn !== this.#turn || !this.#session)
      throw new Error("Tailscale node session ended.");
    if (this.#session.current().guest)
      throw new Error("Create your own vault first.");
    if (
      this.#record &&
      browserNodePublicFingerprint(this.#record, this.#connectionId) !==
        this.#expectedPublic
    )
      throw new Error("The saved Tailscale browser node changed.");
    if (
      this.#record &&
      !this.#writing &&
      browserNodeCredentialFingerprint(this.#record) !==
        this.#expectedCredential
    )
      throw new Error(
        "Tailscale private state changed. Reconnect the browser node.",
      );
  }
  #beginSession(
    input: TailscaleNodeConfiguration,
    url: URL,
    turn: number,
  ): ReturnType<typeof localVaultSessionGuard> {
    const session = localVaultSessionGuard(vaultStore);
    this.#session = session;
    this.#check(turn);
    this.#publish({
      ...stopped(),
      hostname: input.hostname,
      controlURL: url.origin,
      status: "starting",
    });
    return session;
  }
  async start(input: TailscaleNodeConfiguration): Promise<void> {
    this.stop();
    const turn = this.#turn;
    try {
      this.#assertCurrent();
      const url = browserNodeControlURL(input.controlURL);
      const session = this.#beginSession(input, url, turn);
      const config = browserNodeStartConfiguration(
        input,
        url,
        artifacts.assets,
        new URL(import.meta.env.BASE_URL, location.origin),
      );
      const transport = browserNodeTransportOptions(input);
      await this.#retirement.ready();
      this.#check(turn);
      const stored = await openBrowserNodeState(
        { ...config, ...transport, nativeHTTP: transport.nativeHTTP },
        session.current().tomb,
        () => this.#check(turn),
      );
      this.#check(turn);
      if (
        browserNodeCredentialFingerprint(stored.record) !==
          stored.credentialReceipt ||
        browserNodePublicFingerprint(stored.record, stored.connectionId) !==
          stored.publicReceipt
      )
        throw new Error(
          "The saved Tailscale browser node changed during startup.",
        );
      this.#record = stored.record;
      this.#connectionId = stored.connectionId;
      this.#expectedPublic = stored.publicReceipt;
      this.#expected = stored.state;
      this.#expectedCredential = stored.credentialReceipt;
      const observe = () => {
        try {
          this.#check(turn);
        } catch {
          this.#fail(turn);
        }
      };
      this.#releaseVault = vaultStore.subscribe(observe);
      this.#releaseRows = subscribeDeviceRows(observe);
      this.#worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "opensesame-tailscale",
      });
      const channel = new MessageChannel();
      this.#port = channel.port1;
      this.#requests = new BrowserNodeRequests(
        channel.port1,
        () => this.#check(turn),
        () => this.#view.status === "connected" && this.#writing === 0,
        this.#approvePeer,
        () => this.stop(),
        stored.record.nativeHTTP !== undefined,
      );
      const options = nativeWorkerOptions(
        stored.record.nativeHTTP,
        artifacts.assets,
        new URL(import.meta.env.BASE_URL, location.origin),
      );
      this.#listen(channel.port1, this.#requests, turn);
      this.#worker.onerror = () => this.#fail(turn);
      this.#worker.postMessage(
        {
          kind: "start",
          config: {
            ...config,
            state: stored.state,
            nativeHTTP: options.nativeHTTP,
            peerTLS: stored.record.peerTLS,
            assets: { ...config.assets, ...options.asset },
          },
        },
        [channel.port2],
      );
    } catch (error) {
      if (turn === this.#turn) {
        this.stop();
        this.#publish({
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
  /** Nothing dispatched on the Worker object reaches here; only its start port does. */
  #listen(port: MessagePort, requests: BrowserNodeRequests, turn: number) {
    port.onmessage = (event: MessageEvent<BoundaryValue>) => {
      const cleanup = HostMessage.safeParse(event.data);
      if (cleanup.success && cleanup.data.kind === "closeHTTP")
        requests.receive(cleanup.data);
      else this.#receive(event.data, turn);
    };
  }
  #receive(raw: BoundaryValue, turn: number) {
    if (turn !== this.#turn) return;
    const parsed = HostMessage.safeParse(raw);
    if (!parsed.success) {
      this.#fail(turn);
      return;
    }
    const message = parsed.data;
    if (message.kind === "storage") {
      this.#persist(message.state, turn);
      return;
    }
    void this.#writes
      .then(() => {
        this.#check(turn);
        this.#apply(message, turn);
      })
      .catch(() => this.#fail(turn));
  }
  #persist(next: TailscaleNodeState, turn: number) {
    this.#writes = this.#writes.then(async () => {
      this.#check(turn);
      if (!this.#record) throw new Error("Browser node credential is missing.");
      const record = this.#record;
      const state = { ...next };
      this.#writing++;
      this.#publish({});
      try {
        const receipt = await writeBrowserNodeState(
          record,
          this.#expected,
          state,
          () => this.#check(turn),
        );
        this.#check(turn);
        if (
          this.#record !== record ||
          browserNodeCredentialFingerprint(record) !== receipt
        )
          throw new Error("Tailscale private state changed after persistence.");
        this.#expected = state;
        this.#expectedCredential = receipt;
      } finally {
        if (turn === this.#turn) {
          this.#writing--;
          this.#publish({});
        }
      }
      this.#check(turn);
    });
    void this.#writes.catch(() => this.#fail(turn));
  }
  #apply(message: ReturnType<typeof HostMessage.parse>, turn: number): void {
    if (this.#requests?.receive(message)) return;
    if (message.kind === "decision") {
      // Read once: the reply names exactly the URL and method that were decided.
      const { id, url: href, method } = message;
      const url = new URL(href);
      // Optional upstream diagnostic uploads never leave this PWA.
      const allowed =
        url.hostname !== "log.tailscale.com" && this.#approve(url.href, method);
      this.#check(turn);
      this.#port?.postMessage({
        kind: "decision",
        id,
        url: href,
        method,
        allowed,
      });
    } else if (message.kind === "state") {
      this.#running = message.state === "Running";
      if (message.state === "NeedsLogin") this.#publish({ status: "login" });
      else if (message.state === "NeedsMachineAuth")
        this.#publish({ status: "approval" });
      this.#connected();
    } else if (message.kind === "netmap") {
      const map = NetMap.parse(JSON.parse(message.value));
      this.#authorized =
        !map.lockedOut && map.self.machineStatus === "MachineAuthorized";
      this.#publish({
        addresses: map.self.addresses,
        peerCount: map.peers.length,
      });
      this.#connected();
    } else if (message.kind === "auth")
      this.#publish({
        status: "login",
        authURL: browserNodeAuthURL(message.url, this.#view.controlURL),
      });
    else if (message.kind === "error") this.#fail(turn);
  }
  #connected() {
    if (this.#running && this.#authorized && this.#view.addresses.length > 0)
      this.#publish({ status: "connected", authURL: "" });
    else if (this.#view.status === "connected")
      this.#publish({ status: "starting", addresses: [] });
  }
  async forget(): Promise<void> {
    this.stop();
    this.#assertCurrent();
    const session = localVaultSessionGuard(vaultStore);
    try {
      const check = () => {
        this.#assertCurrent();
        session.current();
      };
      await forgetBrowserNodeState(session.current().tomb, check);
    } finally {
      session.close();
    }
  }
  login(): void {
    this.#check();
    this.#port?.postMessage({ kind: "login" });
  }
  captureNativeHTTP(owner: AbortSignal): TailscaleNativeHTTPPort {
    this.#check();
    if (!this.#requests)
      throw new Error("Connect the original browser node first.");
    return this.#requests.capture(owner);
  }
  get(url: string): Promise<{ status: number; text: string }> {
    this.#check();
    if (!this.#requests)
      return Promise.reject(new Error("Connect a browser node first."));
    return this.#requests.get(url);
  }
  #fail(turn: number) {
    if (turn !== this.#turn) return;
    this.stop();
    this.#publish({
      status: "error",
      failure:
        "The Tailscale browser node stopped. Check network access and reconnect.",
    });
  }
  stop(): void {
    this.#turn++;
    this.#retirement.retire(this.#requests, this.#worker);
    this.#requests = null;
    this.#worker = null;
    this.#port = null;
    this.#releaseVault?.();
    this.#releaseVault = null;
    this.#releaseRows?.();
    this.#releaseRows = null;
    this.#session?.close();
    this.#session = null;
    this.#record = null;
    this.#connectionId = "";
    this.#expectedPublic = "";
    this.#expected = {};
    this.#expectedCredential = "";
    this.#writing = 0;
    this.#writes = Promise.resolve();
    this.#running = false;
    this.#authorized = false;
    this.#publish(stopped());
  }
}
