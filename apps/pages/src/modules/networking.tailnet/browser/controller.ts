import { localVaultSessionGuard } from "@opensesame/app-core/lib/secret-backends/local-vault-port.js";
import type {
  TailscaleBrowserNode,
  TailscaleNodeConfiguration,
  TailscaleNodeSnapshot,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  type TailscaleNodeRecord,
  browserNodeCredentialFingerprint,
  forgetBrowserNodeState,
  openBrowserNodeState,
  writeBrowserNodeState,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import artifacts from "../../../lib/capabilities/tailscale-artifacts.json";
import { Configuration, HostMessage, NetMap } from "./protocol.js";
export type BrowserNodePolicy = {
  assertCurrent(): void;
  approve(url: string, method: string): boolean;
  approvePeer(url: string): boolean;
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
  private expected: Record<string, string> = {};
  private expectedCredential = "";
  private writes: Promise<void> = Promise.resolve();
  private writing = 0;
  private releaseVault: (() => void) | null = null;
  private running = false;
  private authorized = false;
  private nextGet = 0;
  private gets = new Map<
    number,
    {
      resolve(value: { status: number; text: string }): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly policy: BrowserNodePolicy) {}
  snapshot = () => this.view;
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
      !this.writing &&
      browserNodeCredentialFingerprint(this.record) !== this.expectedCredential
    )
      throw new Error(
        "Tailscale private state changed. Reconnect the browser node.",
      );
  }
  async start(input: TailscaleNodeConfiguration): Promise<void> {
    this.stop();
    const turn = this.turn;
    try {
      this.policy.assertCurrent();
      const url = new URL(input.controlURL);
      if (
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error(
          "Use an HTTPS control server or an HTTP loopback test server.",
        );
      this.session = localVaultSessionGuard(vaultStore);
      this.check(turn);
      this.publish({
        ...stopped(),
        hostname: input.hostname,
        controlURL: url.origin,
        status: "starting",
      });
      const config = Configuration.parse({
        ...input,
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
        config,
        this.session.current().tomb,
        () => this.check(turn),
      );
      this.check(turn);
      this.record = stored.record;
      this.expected = stored.state;
      this.expectedCredential = browserNodeCredentialFingerprint(stored.record);
      this.releaseVault = vaultStore.subscribe(() => {
        try {
          this.check(turn);
        } catch {
          this.fail(turn);
        }
      });
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "opensesame-tailscale",
      });
      this.worker.onmessage = (event) => this.receive(event.data, turn);
      this.worker.onerror = () => this.fail(turn);
      this.worker.postMessage({
        kind: "start",
        config: { ...config, state: stored.state },
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
  private persist(next: Record<string, string>, turn: number) {
    this.writes = this.writes.then(async () => {
      this.check(turn);
      if (!this.record) throw new Error("Browser node credential is missing.");
      this.writing++;
      try {
        await writeBrowserNodeState(this.record, this.expected, next, () =>
          this.check(turn),
        );
        this.expected = next;
        this.expectedCredential = browserNodeCredentialFingerprint(this.record);
      } finally {
        this.writing--;
      }
      this.check(turn);
    });
    void this.writes.catch(() => this.fail(turn));
  }
  private apply(
    message: ReturnType<typeof HostMessage.parse>,
    turn: number,
  ): void {
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
    else if (message.kind === "get") this.resolveGet(message);
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
  get(url: string): Promise<{ status: number; text: string }> {
    this.check();
    if (this.view.status !== "connected" || !this.policy.approvePeer(url))
      return Promise.reject(
        new Error(
          "Connect a browser node and allow this tailnet service first.",
        ),
      );
    const id = ++this.nextGet;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.gets.delete(id);
        // The published SDK has no per-request cancellation handle.
        this.stop();
        reject(
          new Error(
            "Tailscale peer request timed out; the browser node was disconnected.",
          ),
        );
      }, 30_000);
      this.gets.set(id, { resolve, reject, timer });
      this.worker?.postMessage({ kind: "get", id, url });
    });
  }
  private resolveGet(value: { id: number; status: number; text: string }) {
    const pending = this.gets.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.gets.delete(value.id);
    pending.resolve({ status: value.status, text: value.text });
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
    this.worker?.terminate();
    this.worker = null;
    this.releaseVault?.();
    this.releaseVault = null;
    this.session?.close();
    this.session = null;
    this.record = null;
    this.expected = {};
    this.expectedCredential = "";
    this.writes = Promise.resolve();
    this.running = false;
    this.authorized = false;
    for (const pending of this.gets.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Tailscale node stopped."));
    }
    this.gets.clear();
    this.publish(stopped());
  }
}
