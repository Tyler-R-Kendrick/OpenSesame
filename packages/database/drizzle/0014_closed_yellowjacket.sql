CREATE TABLE "byo_upstreams" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"label" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_auth" text NOT NULL,
	"registration_source" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "byo_upstreams_state_check" CHECK ("byo_upstreams"."state" in ('active','disabled')),
	CONSTRAINT "byo_upstreams_client_auth_check" CHECK ("byo_upstreams"."client_auth" in ('none','client_secret_post')),
	CONSTRAINT "byo_upstreams_registration_source_check" CHECK ("byo_upstreams"."registration_source" in ('manual','dcr'))
);
--> statement-breakpoint
CREATE TABLE "org_email_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_ldap_config" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"bind_mode" text NOT NULL,
	"bind_template" text,
	"search_base_dn" text,
	"search_filter" text,
	"service_bind_dn" text,
	"service_bind_secret" text,
	"subject_attribute" text NOT NULL,
	"attribute_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_role_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_ldap_config_bind_mode_check" CHECK ("org_ldap_config"."bind_mode" in ('bind_template','search_bind'))
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_role_check" CHECK ("organization_memberships"."role" in ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "saml_assertion_replay" (
	"assertion_id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_pending" (
	"request_id" text PRIMARY KEY NOT NULL,
	"interaction_uid" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"external_id" text,
	"user_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_name" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sso_issuer" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "saml_issuer" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "saml_metadata_url" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "saml_metadata_xml" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "provisioning_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_email_domains" ADD CONSTRAINT "org_email_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_ldap_config" ADD CONSTRAINT "org_ldap_config_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_pending" ADD CONSTRAINT "saml_pending_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "byo_upstreams_issuer_uidx" ON "byo_upstreams" USING btree ("issuer");--> statement-breakpoint
CREATE INDEX "org_email_domains_organization_id_idx" ON "org_email_domains" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_org_principal_uidx" ON "organization_memberships" USING btree ("organization_id","principal_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_principal_id_idx" ON "organization_memberships" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "saml_assertion_replay_expires_at_idx" ON "saml_assertion_replay" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "saml_pending_created_at_idx" ON "saml_pending" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tokens_token_hash_uidx" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "scim_tokens_organization_id_idx" ON "scim_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_org_user_name_uidx" ON "scim_users" USING btree ("organization_id","user_name");--> statement-breakpoint
CREATE INDEX "scim_users_org_external_id_idx" ON "scim_users" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "organizations_sso_issuer_idx" ON "organizations" USING btree ("sso_issuer");--> statement-breakpoint
CREATE INDEX "organizations_saml_issuer_idx" ON "organizations" USING btree ("saml_issuer");