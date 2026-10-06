import {
  type LeaseStorePort,
  type ResourceVersion,
  authorizeLease,
  resolverWith,
} from "./lease.js";
import {
  type RequestOptions,
  type RequestPorts,
  describeRequest,
  requestWith,
} from "./request.js";
export interface LeasedRequestPorts {
  request: RequestPorts;
  store: LeaseStorePort;
  inspect(reference: string): Promise<ResourceVersion>;
  now(): number;
}
export async function leasedRequest(
  id: string,
  options: RequestOptions,
  ports: LeasedRequestPorts,
) {
  const binding = describeRequest(options);
  try {
    authorizeLease(
      await ports.store.get(id),
      binding,
      await ports.store.principal(),
      ports.now(),
    );
  } catch {
    throw new Error("Lease authorization denied (details suppressed)");
  }
  const resolve = resolverWith(id, binding, {
    store: ports.store,
    inspect: ports.inspect,
    read: ports.request.resolve,
    now: ports.now,
  });
  const result = await requestWith(options, { ...ports.request, resolve });
  try {
    const lease = await ports.store.get(id);
    return {
      ...result,
      lease: {
        id: lease.id,
        principal: lease.principal,
        expiresAt: lease.expiresAt,
        usesRemaining: lease.usesRemaining,
      },
    };
  } catch {
    throw new Error(
      "Request completed but lease receipt unavailable; do not retry (details suppressed)",
    );
  }
}
