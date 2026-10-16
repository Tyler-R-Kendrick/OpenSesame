/** The optional connector runtime supplies DIRECT, capability-approved HTTP only. */
export type TailscaleTransport = {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  assertCurrent: () => void;
};
let active: TailscaleTransport | null = null;
export function bindTailscaleTransport(
  transport: TailscaleTransport,
): () => void {
  active = transport;
  return () => {
    if (active === transport) active = null;
  };
}
export function tailscaleTransport(): TailscaleTransport {
  if (!active)
    throw new Error("Enable External connectors to configure Tailscale.");
  active.assertCurrent();
  return active;
}
