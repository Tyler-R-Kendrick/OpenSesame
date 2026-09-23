import {
  type MonitorSnapshot,
  connectivitySnapshot,
  subscribeConnectivityMonitor,
} from "@opensesame/app-core/lib/connectivity-monitor.js";
import { useSyncExternalStore } from "react";

/** Subscribe a component to the monitor. Starts it on the first subscriber. */
export function useConnectivityMonitor(): MonitorSnapshot {
  return useSyncExternalStore(
    subscribeConnectivityMonitor,
    connectivitySnapshot,
    connectivitySnapshot,
  );
}
