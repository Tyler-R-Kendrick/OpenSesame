# Organization federation approval

Organization ownership alone does not establish control of an external identity
provider. The deployment operator must approve each organization's issuer binding
before it can configure federation.

1. Create the organization without `ssoIssuer` or `samlIssuer` and record the
   returned `org:<uuid>` ID. Ordinary organization access needs no assignment.
2. Independently verify the enterprise tenant and authorized organization owner
   through administrative onboarding. A submitted issuer URL, verified email,
   trusted provider registry entry or public metadata document is not proof.
3. Set the server-only `OPENSESAME_ORGANIZATION_ISSUER_ASSIGNMENTS` JSON array
   and restart every Identity API replica with the same value:

   ```json
   [
     {
       "organizationId": "org:<uuid>",
       "ssoIssuer": "https://idp.example/enterprise-tenant"
     },
     {
       "organizationId": "org:<another-uuid>",
       "samlIssuer": "urn:example:enterprise-tenant",
       "samlMetadataUrl": "https://idp.example/enterprise-tenant/metadata"
     }
   ]
   ```

4. The organization owner saves the approved fields through the existing PATCH
   endpoint. OIDC client IDs and write-only secrets retain their existing behavior.
   Native SAML requires an explicit entityID and exactly one approved metadata
   source: `samlMetadataUrl` or `samlMetadataXml`. Inline XML matches exactly.
   URL approval binds the provider-controlled endpoint and permits its normal
   certificate rotation. Legacy SAML-to-OIDC brokers need only `samlIssuer`.

Issuer comparisons retain the existing whitespace/trailing-slash convention;
separate tenant paths remain distinct issuers. An issuer cannot be assigned to
multiple organizations, including across OIDC and SAML. Malformed or duplicate
assignments fail startup. Assignment configuration must never be tenant writable
or exposed as browser runtime configuration.

Issuer or native metadata changes require fresh operator approval. Ordinary
organization edits do not. To remove a federation leg, clear `ssoIssuer`, or clear
`samlIssuer` together with its metadata fields. Removing an assignment disables
the leg after restart without deleting the organization or its memberships.

## Existing deployments

The default assignment list is empty. Historical organization rows do not prove
issuer ownership and confer no federation authority until approved. Review and
approve existing bindings before rollout; unapproved federation fields are
inactive and ordinary organization saves may discard them. Unapproved SSO
credentials and native SAML metadata are suppressed before consumers receive
organization rows. Historical unproven claims cannot reserve an issuer against
its approved tenant. No database migration is required.

Use a coordinated rollout: replicas on the old version do not enforce approval.
This version uses explicit operator approval and has no automated issuer-control
challenge ceremony.
