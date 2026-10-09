import type { NativeApiTarget } from "./native-api-target.js";
/** Native API dispatch uses the same authored browser policy as the form. */
import { nativeBrowserApiPolicy } from "./native-browser-policy.js";

export class NativeApiBrowserUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NativeApiBrowserUnavailable";
  }
}

export function assertNativeApiBrowserTarget(target: NativeApiTarget): void {
  const policy = nativeBrowserApiPolicy(target.providerId, target.parameters);
  if (!policy.available)
    throw new NativeApiBrowserUnavailable(
      policy.reason ?? "This provider does not allow direct browser API access",
    );
}
