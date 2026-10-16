/** Browser peering uses the node's own login and encrypted state, without an OAuth app. */
import { FailureNotice } from "../../../components/FailureNotice.js";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";
import { useTailscaleBrowserNodeReady } from "./useTailscaleBrowserNodeReady.js";
import "../connect/connect.css";
export function TailscalePanels({ online }: { online: boolean }) {
  const { ready, failure } = useTailscaleBrowserNodeReady();
  return (
    <div className="cx-setup">
      <FailureNotice
        id="tailscale-browser-storage"
        title="Tailscale"
        message={failure}
      />
      <TailscaleBrowserNode ready={ready} online={online} />
    </div>
  );
}
