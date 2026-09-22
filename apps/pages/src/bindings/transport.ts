import { transportVerifierOrigin } from "../lib/transport-status.js";
import { useSettingsEpoch } from "../lib/use-settings.js";

/** Re-renders when the endpoint changes; false on every fresh origin. */
export function useTransportVerifierConfigured(): boolean {
  useSettingsEpoch();
  return transportVerifierOrigin() !== null;
}
