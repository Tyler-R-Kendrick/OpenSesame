/**
 * Optional extensions Default installs on the minimal PWA (ADR 0153):
 * Identity, Connections, Access and item types. Self-issued OpenID and
 * ambient single sign-on stay off on first boot — they remain choices
 * inside Custom.
 */

import type { CapabilityId } from "@opensesame/capability-composition";

export const DEFAULT_EXTENSIONS: readonly CapabilityId[] = [
  "access.authority",
  "connectors.external",
  "identity.federation",
  "identity.local-iam",
  "vault.certificate-records",
  "vault.derived-records",
  "vault.passkey-records",
];
