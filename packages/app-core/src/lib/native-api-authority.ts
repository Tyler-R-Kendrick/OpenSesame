/** Every API operation requires the complete saved provider verification proof. */
import type { NativeConnectorRecord } from "./native-connector-store.js";
import { nativeConnectorView } from "./native-connector-view.js";

export function assertNativeApiAuthority(record: NativeConnectorRecord): void {
  const grant = record.privateState.grants.app;
  const view = nativeConnectorView(
    record.connectionId,
    record.revision,
    record.configuration,
    record.runtime,
    record.privateState,
  );
  if (
    view.status !== "connected" ||
    !grant ||
    grant.kind !== "api-key" ||
    grant.accessToken !== record.privateState.credentials.api_key
  )
    throw new Error("Verify this provider connection before use");
}

export function assertNativeApiEditable(record: NativeConnectorRecord): void {
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new Error(
      "Finish provider authorization cleanup before verifying this connection",
    );
}
