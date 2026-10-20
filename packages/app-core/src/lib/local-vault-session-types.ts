/**
 * The stored shape of a vault-bound Access session (see
 * `local-vault-sessions.ts`): what a row in `config/vault-sessions`
 * carries, and what creating one takes.
 */

import type { OrganizationRole } from "@opensesame/os-domain";
import type { AccessRole } from "./local-rbac.js";
import type { ShareKind } from "./local-share-grants.js";

export type SessionSubject =
  | { kind: "principal"; principalId: string }
  | { kind: "accessRole"; role: AccessRole }
  | { kind: "orgRole"; role: OrganizationRole };

export type SessionGrantSpec = {
  subject: SessionSubject;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
};

export type LocalVaultSession = {
  id: string;
  code: string;
  label: string;
  status: "running" | "stopped";
  durationSeconds: number;
  startedAt: number | null;
  expiresAt: number | null;
  boundTomb: string;
  grants: SessionGrantSpec[];
  issuedShareIds: string[];
};

export type CreateVaultSessionInput = {
  label: string;
  durationSeconds: number;
  grants: SessionGrantSpec[];
  start?: boolean;
};
