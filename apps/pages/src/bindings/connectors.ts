import {
  type ConnectorStatus,
  buildConnectors,
} from "@opensesame/app-core/lib/connectors.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { useSettingsEpoch } from "../lib/use-settings.js";
import { useConnectivityMonitor } from "./connectivity-monitor.js";
import { usePlaneStatus } from "./planes.js";

export function useConnectors(): ConnectorStatus[] {
  const plane = usePlaneStatus();
  const monitor = useConnectivityMonitor();
  // Capability bindings live in settings, and change without any probe
  // result changing.
  useSettingsEpoch();
  return buildConnectors(plane, monitor, loadSettings());
}
