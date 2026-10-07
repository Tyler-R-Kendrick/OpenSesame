import { randomBytes } from "node:crypto";
import { startReferenceLdapServer } from "@opensesame/mock-upstream-idp/ldap-server";
import type { OrgLdapConfig } from "@opensesame/os-domain";

export const BASE = "dc=outcomes,dc=example";
export const PEOPLE = `ou=people,${BASE}`;
export const SERVICE = `cn=service,${BASE}`;
export const ALICE = `uid=alice,${PEOPLE}`;

export async function directoryFixture() {
  const servicePassword = randomBytes(24).toString("base64url");
  const alicePassword = randomBytes(24).toString("base64url");
  const subject = randomBytes(16).toString("hex");
  const server = await startReferenceLdapServer({
    baseDn: BASE,
    entries: [
      {
        dn: SERVICE,
        password: servicePassword,
        attributes: { objectClass: ["applicationProcess"], cn: ["service"] },
      },
      {
        dn: ALICE,
        password: alicePassword,
        attributes: {
          objectClass: ["inetOrgPerson"],
          uid: ["alice"],
          entryUUID: [subject],
        },
      },
    ],
  });
  const config: OrgLdapConfig = {
    organizationId: "org:ldap-outcomes",
    url: server.url,
    bindMode: "search_bind",
    searchBaseDn: PEOPLE,
    searchFilter: "(uid={username})",
    serviceBindDn: SERVICE,
    serviceBindSecret: servicePassword,
    subjectAttribute: "entryUUID",
    attributeMap: {},
    groupRoleMap: {},
  };
  return { server, config, servicePassword, alicePassword, subject };
}

export type Directory = Awaited<ReturnType<typeof directoryFixture>>;

export function ldapRequest(directory: Directory) {
  const { organizationId: _organizationId, ...body } = directory.config;
  return body;
}
