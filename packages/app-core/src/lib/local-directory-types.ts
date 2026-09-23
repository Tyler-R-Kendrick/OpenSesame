import type { OrganizationRole } from "@opensesame/os-domain";

export class LocalDirectoryError extends Error {
  readonly name = "LocalDirectoryError";
}

export type LocalIdentityKind =
  | "person"
  | "agent"
  | "application"
  | "organization";

export type LocalIdentity = {
  id: string;
  kind: LocalIdentityKind;
  name: string;
  enabled: boolean;
};

export type LocalMembership = {
  organizationId: string;
  principalId: string;
  role: OrganizationRole;
};

export type LocalDirectory = {
  version: 2;
  revision: number;
  entries: LocalIdentity[];
  memberships: LocalMembership[];
};

export type LocalDirectoryChange =
  | { action: "create"; kind: LocalIdentityKind; name: string; id?: string }
  | { action: "update"; id: string; name: string; enabled: boolean }
  | { action: "delete"; id: string }
  | {
      action: "membership";
      organizationId: string;
      principalId: string;
      role: OrganizationRole | null;
    };
