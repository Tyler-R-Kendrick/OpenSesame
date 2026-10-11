/**
 * The keys of one saved model provider, live (ADR 0189 §6).
 *
 * The broker keeps keys in memory and tells watchers when any change; this hook
 * reads them again on that signal and on a slow tick, because a key ends by the
 * clock and the clock is not an event.
 */
import {
  activeModelKeyBroker,
  modelKeysVersion,
  subscribeModelKeys,
} from "@opensesame/app-core/lib/model-keys/active.js";
import type { KeyView } from "@opensesame/app-core/lib/model-keys/types.js";
import { useEffect, useState, useSyncExternalStore } from "react";

const TICK_MS = 30_000;

export type ModelKeys = Readonly<{
  /** Is a broker bound? Keys exist only while External connectors is on. */
  ready: boolean;
  keys: readonly KeyView[];
  now: number;
  /** Changes whenever a key does; a reader memoising on keys may depend on it. */
  version: number;
}>;

export function useModelKeys(connectionId: string): ModelKeys {
  const version = useSyncExternalStore(
    subscribeModelKeys,
    modelKeysVersion,
    modelKeysVersion,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const broker = activeModelKeyBroker();
  if (!broker) return { ready: false, keys: [], now, version };
  const keys = broker.list().filter((key) => key.connectionId === connectionId);
  return { ready: true, keys, now, version };
}
