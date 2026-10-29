import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeOAuthClientConfigured } from "../../../modules/connectors.external/native-oauth-resource-runtime.js";

export function usesMcp(view: NativeConnectorView) {
  return (
    view.configuration.method === "mcp" ||
    (nativeOAuthClientConfigured(view.configuration) &&
      view.configuration.parameters.resource_protocol === "mcp")
  );
}
