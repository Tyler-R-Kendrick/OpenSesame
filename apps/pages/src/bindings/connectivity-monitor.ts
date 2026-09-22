import { useSyncExternalStore } from "react";
import {
  type MonitorSnapshot,
  connectivitySnapshot,
  subscribeConnectivityMonitor,
} from "../lib/connectivity-monitor.js";

/** Subscribe a component to the monitor. Starts it on the first subscriber. */
export function useConnectivityMonitor(): MonitorSnapshot {
  return useSyncExternalStore(
    subscribeConnectivityMonitor,
    connectivitySnapshot,
    connectivitySnapshot,
  );
}
