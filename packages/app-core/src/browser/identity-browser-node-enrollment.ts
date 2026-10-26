/** Explicit pre-unlock enrollment, shared by native identity protocols; no provider secrets live here. */
import type {
  IdentityBrowserNode,
  IdentityBrowserNodeOwner,
} from "../lib/tailscale/browser-node-identity-port.js";
import type { TailscaleNodeSnapshot } from "../lib/tailscale/browser-node-port.js";
import { savedBrowserNodeConfiguration } from "../lib/tailscale/browser-node-store.js";
type PeeringPrompt = Readonly<{
  label: string;
  node: IdentityBrowserNode;
  state: TailscaleNodeSnapshot;
  cancel: () => void;
}>;
let pending: PeeringPrompt | null = null;
const watchers = new Set<() => void>();
export const nativeIdentityPeering = () => pending;
export function subscribeNativeIdentityPeering(
  listener: () => void,
): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}
function changed() {
  for (const listener of watchers) listener();
}
class Enrollment {
  private done = false;
  private ending = false;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly node: IdentityBrowserNode,
    private readonly owner: IdentityBrowserNodeOwner,
    private readonly label: string,
    private readonly resolve: () => void,
    private readonly reject: (error: Error) => void,
  ) {}
  private finish(error?: Error) {
    if (this.done) return;
    this.done = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.unsubscribe?.();
    this.owner.signal.removeEventListener("abort", this.abort);
    const notify = pending?.node === this.node;
    if (notify) pending = null;
    if (error) this.reject(error);
    else this.resolve();
    if (notify) changed();
  }
  private abort = () => {
    if (this.done || this.ending) return;
    this.ending = true;
    void this.node.stop().then(
      (closed) =>
        this.finish(
          new Error(
            closed
              ? "Original identity enrollment was cancelled"
              : "Original identity node did not acknowledge physical drain",
          ),
        ),
      () => this.finish(new Error("Original identity node could not close")),
    );
  };
  private observe = () => {
    if (this.done || this.ending) return;
    try {
      this.owner.signal.throwIfAborted();
      this.owner.assertCurrent();
      const state = this.node.snapshot();
      if (state.status === "connected") {
        this.owner.assertCurrent();
        this.finish();
        return;
      }
      if (state.status === "error" || state.status === "stopped") {
        this.abort();
        return;
      }
      pending = Object.freeze({
        label: this.label,
        node: this.node,
        state,
        cancel: this.abort,
      });
      changed();
      this.owner.signal.throwIfAborted();
      this.owner.assertCurrent();
    } catch {
      this.abort();
    }
  };
  start() {
    try {
      this.owner.signal.throwIfAborted();
      this.owner.assertCurrent();
      const config = savedBrowserNodeConfiguration();
      if (!config?.nativeHTTP)
        throw new Error(
          "Configure Networking's native HTTPS route and trust before native identity sign-in",
        );
      this.unsubscribe = this.node.subscribe(this.observe);
      this.owner.signal.addEventListener("abort", this.abort, { once: true });
      this.timer = setTimeout(this.abort, 600000);
      this.node.start({
        controlURL: config.controlURL,
        nativeHTTP: config.nativeHTTP,
      });
      this.observe();
    } catch (error) {
      this.ending = true;
      void this.node.stop().then(
        () =>
          this.finish(
            error instanceof Error
              ? error
              : new Error("Original identity enrollment failed"),
          ),
        () => this.finish(new Error("Original identity node could not close")),
      );
    }
  }
}
export async function enrollIdentityBrowserNode(
  node: IdentityBrowserNode | null,
  owner: IdentityBrowserNodeOwner,
  label: string,
) {
  if (!node)
    throw new Error("Enable Networking before native identity sign-in");
  if (pending) throw new Error("Finish the original identity enrollment first");
  await new Promise<void>((resolve, reject) =>
    new Enrollment(node, owner, label, resolve, reject).start(),
  );
  owner.signal.throwIfAborted();
  owner.assertCurrent();
  return node;
}
export async function retireIdentityBrowserNode(
  node: IdentityBrowserNode | null,
) {
  if (node && !(await node.stop()))
    throw new Error(
      "Original identity node did not acknowledge physical drain",
    );
}
