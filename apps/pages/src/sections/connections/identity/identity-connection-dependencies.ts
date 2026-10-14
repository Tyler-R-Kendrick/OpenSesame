import type { Connection } from "@opensesame/app-core/lib/connections.js";
import { beginSignIn } from "@opensesame/app-core/lib/federation.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  identityConnectionPreset,
  listIdentityConnectionOrganizations,
  listIdentityConnections,
  readIdentityConnection,
  readInitialIdentityDraft,
  removeIdentityConnection,
  saveIdentityConnection,
  testIdentityConnection,
} from "@opensesame/app-core/lib/identity-connections.js";
import {
  normalizeSignInService,
  readSignInService,
  writeSignInService,
} from "@opensesame/app-core/lib/identity-service.js";
import { brokeredRealmUpstream } from "@opensesame/app-core/lib/providers.js";

/** The UI port; adapter tests exercise the real implementations. */
export const identityConnectionDependencies = {
  beginSignIn,
  brokeredRealmUpstream,
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  listIdentityConnectionOrganizations,
  listIdentityConnections,
  readIdentityConnection,
  readInitialIdentityDraft,
  removeIdentityConnection,
  saveIdentityConnection,
  testIdentityConnection,
  normalizeSignInService,
  readSignInService,
  writeSignInService,
};
export function isIdentityConnectionProvider(providerId: string): boolean {
  return identityConnectionPreset(providerId) !== null;
}
export function currentIdentityConnection(
  providerId: string,
  connection: Connection | null,
): Connection | null {
  if (
    connection &&
    identityConnectionDependencies.readIdentityConnection(
      connection.connectionId,
    )
  )
    return connection;
  return (
    identityConnectionDependencies
      .listIdentityConnections()
      .find((entry) => entry.providerId === providerId) ?? null
  );
}
