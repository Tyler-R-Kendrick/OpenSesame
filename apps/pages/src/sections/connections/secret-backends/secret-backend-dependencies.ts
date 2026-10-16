import type { Connection } from "@opensesame/app-core/lib/connections.js";
import {
  connectSecretBackend,
  deleteSecretBackendConnection,
  listSecretBackendConnections,
  probeSecretBackend,
  readSecretBackendConnection,
  saveSecretBackendConnection,
} from "@opensesame/app-core/lib/secret-backends/index.js";
import {
  secretBackendDraft,
  secretBackendPreset,
} from "@opensesame/app-core/lib/secret-backends/presets.js";

/** The UI port keeps tests at the same boundary every partner composes. */
export const secretBackendDependencies = {
  connectSecretBackend,
  deleteSecretBackendConnection,
  listSecretBackendConnections,
  probeSecretBackend,
  readSecretBackendConnection,
  saveSecretBackendConnection,
  secretBackendDraft,
};
export function isSecretBackendProvider(providerId: string) {
  return secretBackendPreset(providerId) !== null;
}
export function currentSecretBackend(
  providerId: string,
  connection: Connection | null,
) {
  if (
    connection &&
    secretBackendDependencies.readSecretBackendConnection(
      connection.connectionId,
    )
  )
    return connection;
  return (
    secretBackendDependencies
      .listSecretBackendConnections()
      .find((entry) => entry.providerId === providerId) ?? null
  );
}
