import type { NativeProviderTransport } from "./native-connector-transport.js";

/** Actual validated token and resource targets carried by one already-captured authority. */
export type NativeBrowserPolicyCarrier = Readonly<{
  transport: Pick<
    NativeProviderTransport,
    "assertCurrent" | "signal" | "supportsNativeOrigin"
  >;
  tokenEndpoint: string;
  resourceEndpoint: string;
}>;

export type NativeResourcePolicyCarrier = Readonly<
  Pick<NativeBrowserPolicyCarrier, "transport" | "resourceEndpoint">
>;
export type NativeMethodPolicyCarrier =
  | NativeBrowserPolicyCarrier
  | NativeResourcePolicyCarrier;
function destinationsCurrent(
  transport: NativeBrowserPolicyCarrier["transport"],
  endpoints: readonly string[],
): boolean {
  if (!transport.supportsNativeOrigin) return false;
  try {
    transport.assertCurrent();
    transport.signal?.throwIfAborted();
    for (const endpoint of endpoints) {
      const url = new URL(endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        transport.supportsNativeOrigin(url.origin) !== true
      )
        return false;
      transport.assertCurrent();
      transport.signal?.throwIfAborted();
    }
    return true;
  } catch {
    return false;
  }
}
/** OAuth still requires both validated token and resource targets on the original route. */
export function nativePolicyCarrierCurrent(
  carrier?: NativeBrowserPolicyCarrier,
): boolean {
  return (
    !!carrier &&
    destinationsCurrent(carrier.transport, [
      carrier.tokenEndpoint,
      carrier.resourceEndpoint,
    ])
  );
}
/** Non-OAuth MCP has exactly one resource target and never invents an authorization endpoint. */
export function nativeResourcePolicyCarrierCurrent(
  carrier?: NativeResourcePolicyCarrier,
): boolean {
  return (
    !!carrier &&
    destinationsCurrent(carrier.transport, [carrier.resourceEndpoint])
  );
}
