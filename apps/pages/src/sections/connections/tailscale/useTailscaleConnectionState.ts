/** SDK status changes reproject local facts; they never reload a provider or write a row. */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  readDeviceRows,
  subscribeDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnectorView } from "@opensesame/app-core/lib/device-connector-view.js";
import { isDeviceConnectorId } from "@opensesame/app-core/lib/device-connectors.js";
import {
  type TailscaleNodeSnapshot,
  subscribeTailscaleBrowserNode,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { nativeConnectorHeaderStatus } from "../SettingsPageNativeStatus.js";

const absent = () => null;
const noSubscribe = () => () => {};

export function currentTailscaleConnections(
  rows: Connection[] | null,
): Connection[] | null {
  if (!rows) return null;
  const retained = rows.filter(
    (row) =>
      !(
        row.providerId === "tailscale" &&
        isDeviceConnectorId(row.connectionId) &&
        row.connectionRef === `local/connector/${row.connectionId}`
      ),
  );
  return [
    ...retained,
    ...readDeviceRows()
      .filter((row) => row.providerId === "tailscale")
      .map(deviceConnectorView),
  ];
}

export function useTailscaleConnectionState(
  onChanged?: (state: TailscaleNodeSnapshot | null) => void,
) {
  const node = useSyncExternalStore(
    subscribeTailscaleBrowserNode,
    tailscaleBrowserNode,
    absent,
  );
  const state = useSyncExternalStore(
    node?.subscribe ?? noSubscribe,
    node?.snapshot ?? absent,
    absent,
  );
  useEffect(() => {
    onChanged?.(state);
  }, [onChanged, state]);
  useEffect(
    () => (onChanged ? subscribeDeviceRows(() => onChanged(state)) : undefined),
    [onChanged, state],
  );
}

export function useTailscaleHeaderStatus(
  connection: Connection | null,
  provider: Provider | null,
) {
  useTailscaleConnectionState();
  return provider ? nativeConnectorHeaderStatus(connection, provider) : null;
}

export function useTailscaleConnections() {
  const state = useState<Connection[] | null>(null);
  const [, setConnections] = state;
  const refresh = useCallback(
    () => setConnections(currentTailscaleConnections),
    [setConnections],
  );
  useTailscaleConnectionState(refresh);
  return state;
}
