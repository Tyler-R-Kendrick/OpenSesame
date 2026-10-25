import { randomBytes } from "node:crypto";
import { startReferenceLdapServer } from "@opensesame/mock-upstream-idp/ldap-server";
import { startReferenceIdp } from "@opensesame/mock-upstream-idp/testkit";
import { describe, expect, it } from "vitest";
import {
  closeEnterpriseServer,
  enterpriseLogin,
  enterpriseOwner,
  enterpriseRequest,
  enterpriseServer,
  hiddenField,
} from "./enterprise-signin.test-support.js";
import { hopUrl } from "./upstream-hop.js";

describe("saved enterprise connections", () => {
  it("configures native SAML and authenticates through the selected organization", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    const started = await enterpriseServer(idp.issuer);
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const id = "org:saml-saved";
      const slug = "saved-saml";
      const headers = await enterpriseOwner(started, id, slug);
      started.ctx.config.organizationIssuerAllowlist = [
        ...(started.ctx.config.organizationIssuerAllowlist ?? []),
        `${id}|${idp.saml.entityId}`,
      ];
      const saved = await started.app.request(
        `/v1/organizations/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            samlIssuer: idp.saml.entityId,
            samlMetadataUrl: idp.saml.metadataUrl,
            samlMetadataXml: null,
          }),
        },
      );
      expect(saved.status).toBe(200);
      const { jar, uid, html } = await enterpriseLogin(base, slug);
      expect(html).toContain(`/interaction/${uid}/federated/saml`);
      expect(hiddenField(html, "slug")).toBe(slug);
      const subject = `saved-saml-${randomBytes(12).toString("hex")}`;
      idp.setSubject(subject);
      const start = await enterpriseRequest(
        base,
        jar,
        `/interaction/${uid}/federated/saml`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            _csrf: hiddenField(html, "_csrf"),
            slug,
          }),
        },
      );
      const signedHtml = await (
        await fetch(await hopUrl(start), { redirect: "manual" })
      ).text();
      const acsUrl = signedHtml.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "";
      // The cross-site ACS POST carries no cookie. The top-level completion
      // resumes the cookie-bound interaction only after verifying XML-DSig.
      const acs = await fetch(acsUrl, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          SAMLResponse: hiddenField(signedHtml, "SAMLResponse"),
        }),
      });
      expect(acs.status).toBe(303);
      const complete = await enterpriseRequest(
        base,
        jar,
        acs.headers.get("location") ?? "",
      );
      expect(complete.status).toBe(303);
      const linked = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "saml",
        issuer: idp.saml.entityId,
        tenant: id,
        subject,
      });
      expect(linked?.assurance).toBe("verified");
      expect(
        (
          await started.ctx.stores.organizationMemberships.find(
            id,
            linked?.principalId ?? "",
          )
        )?.role,
      ).toBe("member");
    } finally {
      await closeEnterpriseServer(started);
      await idp.close();
    }
  }, 30_000);

  it("configures LDAP and signs in with a real directory bind from the saved organization hint", async () => {
    const password = randomBytes(24).toString("base64url");
    const directory = await startReferenceLdapServer({
      baseDn: "dc=example",
      entries: [
        {
          dn: "uid=alice,ou=people,dc=example",
          password,
          attributes: {
            uid: ["alice"],
            cn: ["Alice"],
            entryUUID: ["saved-alice-subject"],
            objectClass: ["inetOrgPerson"],
          },
        },
      ],
    });
    const started = await enterpriseServer();
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const id = "org:ldap-saved";
      const slug = "saved-ldap";
      const headers = await enterpriseOwner(started, id, slug);
      const saved = await started.app.request(
        `/v1/organizations/${encodeURIComponent(id)}/ldap`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            url: directory.url,
            bindMode: "bind_template",
            bindTemplate: "uid={username},ou=people,dc=example",
            subjectAttribute: "entryUUID",
            attributeMap: { name: "cn" },
            groupRoleMap: {},
          }),
        },
      );
      expect(saved.status).toBe(200);
      const { jar, uid, html } = await enterpriseLogin(base, slug);
      expect(hiddenField(html, "slug")).toBe(slug);
      expect(html).toContain('name="username"');
      expect(html).toContain('name="password"');
      const signedIn = await enterpriseRequest(
        base,
        jar,
        `/interaction/${uid}/federated/ldap`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            _csrf: hiddenField(html, "_csrf"),
            slug,
            username: "alice",
            password,
          }),
        },
      );
      expect(await hopUrl(signedIn)).toContain("/auth/");
      const linked = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "ldap",
        issuer: directory.url,
        subject: "saved-alice-subject",
      });
      expect(linked?.assurance).toBe("verified");
      expect(
        (
          await started.ctx.stores.organizationMemberships.find(
            id,
            linked?.principalId ?? "",
          )
        )?.role,
      ).toBe("member");
      const absent = await enterpriseLogin(base, "unknown-organization");
      expect(absent.html).toContain("No organization sign-in is configured");
      expect(absent.html).not.toContain('name="username"');
    } finally {
      await closeEnterpriseServer(started);
      await directory.close();
    }
  }, 30_000);
});
