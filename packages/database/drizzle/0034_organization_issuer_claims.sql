CREATE TABLE "organization_issuer_claims" (
	"issuer" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_issuer_claims" ADD CONSTRAINT "organization_issuer_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Same trim set as ECMAScript String.trim(), without URL/case rewriting.
CREATE FUNCTION organization_normalized_issuer(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT rtrim(btrim(value,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) ||
    chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
    chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
    chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) ||
    chr(8239) || chr(8287) || chr(12288) || chr(65279)), '/');
$$;
--> statement-breakpoint
-- Prevent concurrent organization writes during backfill/trigger installation.
-- A legacy cross-tenant collision aborts the migration, never chooses an owner.
LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO organization_issuer_claims (issuer, organization_id)
SELECT DISTINCT organization_normalized_issuer(value), o.id
FROM organizations o
CROSS JOIN LATERAL (VALUES (o.sso_issuer), (o.saml_issuer)) AS issuers(value)
WHERE organization_normalized_issuer(value) <> '';
--> statement-breakpoint
CREATE FUNCTION organization_sync_issuer_claims() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM organization_issuer_claims WHERE organization_id = NEW.id;
  INSERT INTO organization_issuer_claims (issuer, organization_id)
  SELECT DISTINCT organization_normalized_issuer(value), NEW.id
  FROM (VALUES (NEW.sso_issuer), (NEW.saml_issuer)) AS issuers(value)
  WHERE organization_normalized_issuer(value) <> ''
  ORDER BY 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- AFTER executes only the actual upsert branch; claim conflicts roll back the
-- organization row and the previous claim release in the same transaction.
CREATE TRIGGER organizations_sync_issuer_claims
AFTER INSERT OR UPDATE OF sso_issuer, saml_issuer ON organizations
FOR EACH ROW EXECUTE FUNCTION organization_sync_issuer_claims();
