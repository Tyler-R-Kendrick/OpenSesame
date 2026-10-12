/** Provider mutations settle, but cancelled attempts cannot verify or activate grants. */
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { optionalNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";

export function captureNativeAuthorizationTransport(
  base: NativeProviderTransport,
): NativeProviderTransport {
  const guard = optionalNativeOAuthBrowserPort()?.captureAuthorizationGuard?.();
  if (!guard) return base;
  const assertCurrent = () => {
    base.assertCurrent();
    guard();
  };
  const mutation = base.settleCredentialMutation;
  const captured: NativeProviderTransport = {
    assertCurrent,
    fetch: (input, init) => {
      assertCurrent();
      return base.fetch(input, init);
    },
  };
  if (mutation)
    captured.settleCredentialMutation = (input, init) => {
      assertCurrent();
      // Once sent, its minted token must reach the durable recovery journal.
      return mutation(input, init);
    };
  return captured;
}
