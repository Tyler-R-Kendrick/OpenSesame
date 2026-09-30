/**
 * Optional extensions Default installs on the minimal PWA (ADR 0153):
 * Identity, Connections, Access and item types. Ambient single sign-on
 * stays off — it reloads the document and signs in silently, so it
 * remains a choice inside Custom.
 */

import type { CapabilityId } from "@opensesame/capability-composition";

export const DEFAULT_EXTENSIONS: readonly CapabilityId[] = [
  "access.authority",
  "connectors.external",
  "identity.federation",
  "identity.local-iam",
  "identity.siop",
  "vault.certificate-records",
  "vault.derived-records",
  "vault.passkey-records",
];
