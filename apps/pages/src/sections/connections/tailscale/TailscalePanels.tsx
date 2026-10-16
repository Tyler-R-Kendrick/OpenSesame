import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";
import {
  TailscaleAppImport,
  TailscaleConfiguration,
} from "./TailscaleConfiguration.js";
import { TailscaleDevicePanel } from "./TailscaleDevicePanel.js";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";
import { useTailscaleApp } from "./useTailscaleApp.js";
import "../connect/connect.css";
type Props = {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
};
export function TailscalePanels({
  connection,
  online,
  onFlash,
  onChanged,
}: Props) {
  const model = useTailscaleApp(connection?.connectionId, onChanged, onFlash);
  const callback =
    model.saved?.redirectUri ?? deps.optionalBrowser()?.redirectUri ?? "";
  return (
    <div className="cx-setup">
      <TailscaleBrowserNode ready={model.ready} online={online} />
      <TailscaleConfiguration
        model={model}
        callback={callback}
        online={online}
      />
      <TailscaleAppImport model={model} online={online} />
      <TailscaleDevicePanel model={model} />
    </div>
  );
}
