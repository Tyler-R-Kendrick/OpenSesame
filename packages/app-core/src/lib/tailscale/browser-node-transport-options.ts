import { TailscaleHTTPRouteConfiguration } from "./browser-node-peer-http.js";
import {
  type TailscaleNodeConfiguration,
  TailscaleServerTrustConfiguration,
} from "./browser-node-port.js";

type BrowserNodeTransportOptions = {
  nativeHTTP?: TailscaleHTTPRouteConfiguration;
  peerTLS?: TailscaleServerTrustConfiguration;
};

/** Capture routing and independent peer trust before custody can await. */
export function browserNodeTransportOptions(
  config: Pick<TailscaleNodeConfiguration, "nativeHTTP" | "peerTLS">,
) {
  const options: BrowserNodeTransportOptions = {};
  if (config.nativeHTTP !== undefined)
    options.nativeHTTP = TailscaleHTTPRouteConfiguration.parse(
      config.nativeHTTP,
    );
  if (config.peerTLS !== undefined)
    options.peerTLS = TailscaleServerTrustConfiguration.parse(config.peerTLS);
  return options;
}
