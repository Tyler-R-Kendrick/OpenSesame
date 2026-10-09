/** Shared model authority port. Provider implementations are installed by their capability. */
import type { BoundaryValue } from "@opensesame/os-domain";
export type HostedModelTransport = {
  fetch: typeof fetch;
  assertCurrent: () => void;
};
export type HostedModelFence = HostedModelTransport & { signal: AbortSignal };
export type HostedModelConnection = {
  connectionId: string;
  providerId: string;
  status: string;
  method: string;
};
export type HostedModelOperation = {
  providerId: string;
  operationId: string;
  method: "GET" | "POST";
  origin?: string;
  path: string;
  headers?: Record<string, string>;
};
export type HostedModelAuthority = HostedModelTransport & {
  read: (connectionId: string) => HostedModelConnection | null;
  connections: () => readonly HostedModelConnection[];
  execute: (
    connectionId: string,
    definition: HostedModelOperation,
    body: BoundaryValue,
    project: (body: BoundaryValue) => BoundaryValue,
    fence: HostedModelFence,
  ) => Promise<BoundaryValue>;
};
let active: HostedModelAuthority | null = null;
export function bindHostedModelAuthority(
  authority: HostedModelAuthority,
): () => void {
  active = authority;
  return () => {
    if (active === authority) active = null;
  };
}
/** Captured adapters remain bound to their original capability activation. */
export function hostedModelAuthority(): HostedModelAuthority | null {
  if (!active) return null;
  try {
    active.assertCurrent();
    return active;
  } catch {
    return null;
  }
}
