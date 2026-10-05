import { effectiveGestures } from "@opensesame/app-core/lib/keymap/gesture-bindings.js";
import {
  loadKeymap,
  subscribeKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { useEffect, useSyncExternalStore } from "react";
import { listenForShake } from "./gesture-motion.js";
import {
  type GestureHost,
  installGestures,
  runGesture,
} from "./gesture-runtime.js";

/**
 * The gesture loadout, live while the shell is (ADR 0170). Two fingers are
 * listened for on the document; the motion sensor only while a shake is bound
 * and motion is on, so a phone that never shakes never runs the sensor.
 */
export function useGestures(host: GestureHost): void {
  const { navigate, showHelp, chord } = host;
  useEffect(
    () => installGestures({ navigate, showHelp, chord }),
    [navigate, showHelp, chord],
  );
  const config = useSyncExternalStore(subscribeKeymap, loadKeymap, loadKeymap);
  const shaking = effectiveGestures(config).has("shake");
  useEffect(() => {
    if (!shaking) return;
    return listenForShake(() =>
      runGesture(
        "shake",
        { target: document.activeElement },
        { navigate, showHelp, chord },
      ),
    );
  }, [shaking, navigate, showHelp, chord]);
}
