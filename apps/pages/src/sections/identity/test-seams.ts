/**
 * Seam installs and their handles for the Identity section suites.
 *
 * Nothing here mocks a module: each seam object is real, and the test
 * replaces its members. Lifted out of IdentitySection.test.tsx so that
 * file stays inside the 400-line budget's recorded allowance.
 */

import { vi } from "vitest";
import type { IdentitySession } from "../../lib/identity.js";

export const online = { value: true };
export const session: { current: IdentitySession | null } = {
  current: null,
};
export const connect = vi.fn();
export const beginSignIn = vi.fn();
export const listFederatedProviders = vi.fn();
export const registerByoProvider = vi.fn();
export const registry: { raw: string | null } = { raw: null };

import { deviceIdentitySeams } from "../../lib/device-identity.js";

export { deviceIdentitySeams };
import { identityHookSeams } from "../../bindings/identity.js";
import { identitySeams } from "../../lib/identity.js";
export const originalRemoteIdentityApi = deviceIdentitySeams.remoteIdentityApi;
identitySeams.identityBase = () => "http://127.0.0.1:8788";
Object.assign(identityHookSeams, {
  useConnect: () => ({ connect, connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:8788";

import { useOnlineSeams } from "../../lib/use-online.js";
Object.assign(useOnlineSeams, { useOnline: () => online.value });

import { idpRegistrySeams } from "../../lib/idp-registry.js";
Object.assign(idpRegistrySeams, {
  read: () => registry.raw,
  write: (raw: string) => {
    registry.raw = raw;
  },
  clear: () => {
    registry.raw = null;
  },
});

import { providersSeams } from "../../lib/providers.js";
Object.assign(providersSeams, { listFederatedProviders });

import { federationSeams } from "../../lib/federation.js";
Object.assign(federationSeams, {
  beginSignIn,
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google (via shoo.dev)",
  }),
});

import { ByoError, byoSeams } from "../../lib/byo.js";
Object.assign(byoSeams, { registerByoProvider });

export const directory = {
  getMe: vi.fn(),
  listLinkedIdentities: vi.fn(),
  unlinkIdentity: vi.fn(),
  listOAuthClients: vi.fn(),
  createOAuthClient: vi.fn(),
  rotateOAuthClient: vi.fn(),
  revokeOAuthClient: vi.fn(),
  listOrgMembers: vi.fn(),
  addOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  createOrganization: vi.fn(),
  approveDevice: vi.fn(),
};

import { DirectoryError, directorySeams } from "../../lib/directory.js";
Object.assign(directorySeams, directory);

export const listOrgMemberships = vi.fn();
export const activeOrgProfileId = vi.fn();

import { orgSeams } from "../../lib/orgs.js";
Object.assign(orgSeams, { listOrgMemberships, activeOrgProfileId });

export { ByoError, DirectoryError };
