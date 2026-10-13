import { assertNotGuestSession, isGuestSession } from "./guest-isolation.js";
import type { PagesSettings } from "./settings.js";

type TrustAnchorDefaults = { hostApi: string; identityApi: string };

function trustAnchorsOf(
  settings: PagesSettings,
  defaults: TrustAnchorDefaults,
) {
  return {
    hostApi: settings.hostApi.trim() || defaults.hostApi,
    identityApi: settings.identityApi.trim() || defaults.identityApi,
  };
}

export function assertGuestMayNotChangeTrustAnchors(
  prior: PagesSettings,
  next: PagesSettings,
  defaults: TrustAnchorDefaults,
): void {
  if (!isGuestSession()) return;
  const before = trustAnchorsOf(prior, defaults);
  const after = trustAnchorsOf(next, defaults);
  if (
    before.hostApi !== after.hostApi ||
    before.identityApi !== after.identityApi
  ) {
    assertNotGuestSession("change Host or Identity endpoints");
  }
}
