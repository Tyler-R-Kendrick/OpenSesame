import { useSyncExternalStore } from "react";
import { settingsEpoch, subscribeSettings } from "./settings.js";

/**
 * Re-render when persisted settings change.
 *
 * Deliberately a number rather than the settings object: `loadSettings()`
 * builds a fresh object every call, so a store returning it would never
 * compare equal and would re-render forever.
 */
export function useSettingsEpoch(): number {
  return useSyncExternalStore(subscribeSettings, settingsEpoch, settingsEpoch);
}
