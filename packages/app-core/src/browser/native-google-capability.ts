/** Strict vault isolation remains authoritative for Google's popup SDK. */
declare const __NATIVE_GOOGLE_HEADER_SECURITY__: boolean;
export function nativeGoogleBrowserAvailable(): boolean {
  return !__NATIVE_GOOGLE_HEADER_SECURITY__ && !globalThis.crossOriginIsolated;
}
