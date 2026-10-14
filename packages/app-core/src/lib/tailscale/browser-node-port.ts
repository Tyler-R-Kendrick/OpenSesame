/** The optional Networking module owns the browser WASM client and its lifetime. */
export type TailscaleNodeConfiguration = Readonly<{
  hostname: string;
  controlURL: string;
  authKey?: string;
}>;
export type TailscaleNodeSnapshot = Readonly<{
  status: "stopped" | "starting" | "login" | "approval" | "connected" | "error";
  hostname: string;
  controlURL: string;
  authURL: string;
  addresses: readonly string[];
  peerCount: number;
  failure: string;
}>;
export type TailscaleBrowserNode = {
  snapshot(): TailscaleNodeSnapshot;
  subscribe(listener: () => void): () => void;
  start(config: TailscaleNodeConfiguration): Promise<void>;
  stop(): void;
  forget(): Promise<void>;
  login(): void;
  get(url: string): Promise<{ status: number; text: string }>;
};
let current: TailscaleBrowserNode | null = null;
const watchers = new Set<() => void>();
export function subscribeTailscaleBrowserNode(
  listener: () => void,
): () => void {
  watchers.add(listener);
  return () => watchers.delete(listener);
}
export function bindTailscaleBrowserNode(
  node: TailscaleBrowserNode,
): () => void {
  current = node;
  for (const listener of watchers) listener();
  return () => {
    node.stop();
    if (current === node) current = null;
    for (const listener of watchers) listener();
  };
}
export function tailscaleBrowserNode(): TailscaleBrowserNode | null {
  return current;
}
