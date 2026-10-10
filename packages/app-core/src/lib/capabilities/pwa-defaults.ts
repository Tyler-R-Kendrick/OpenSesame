/**
 * Optional capabilities the static PWA turns on before anyone opens Settings
 * (Tyler, 2026-10): Access and browser-local IAM so Sent drops, Receipts and
 * grants are visible on a fresh install.
 */

import type { CapabilityId } from "@opensesame/capability-composition";

export const PWA_DEFAULT_OPTIONALS: readonly CapabilityId[] = [
  "access.authority",
  "identity.local-iam",
];
