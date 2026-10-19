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

/** Origin evidence from browser Fetch does not constrain this explicitly granted native carrier. */
export function nativePolicyCarrierCurrent(
  carrier?: NativeBrowserPolicyCarrier,
): boolean {
  if (!carrier?.transport.supportsNativeOrigin) return false;
  const { transport } = carrier;
  try {
    transport.assertCurrent();
    transport.signal?.throwIfAborted();
    for (const endpoint of [carrier.tokenEndpoint, carrier.resourceEndpoint]) {
      const url = new URL(endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        transport.supportsNativeOrigin?.(url.origin) !== true
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
