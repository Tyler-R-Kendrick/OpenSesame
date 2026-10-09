CREATE TABLE "agent_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"public_key_jkt" text NOT NULL,
	"client_id" text,
	"runtime_provider" text,
	"attestation_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"provider" text,
	"software_identity" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_state_check" CHECK ("agents"."state" in ('provisional','claimed','suspended','revoked'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"principal_id" text,
	"actor_type" text,
	"actor_id" text,
	"agent_instance_id" text,
	"client_id" text,
	"organization_id" text,
	"project_id" text,
	"claim_id" text,
	"session_id" text,
	"target_type" text,
	"target_id" text,
	"outcome" text NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" in ('succeeded','failed','denied'))
);
--> statement-breakpoint
CREATE TABLE "better_auth_subjects" (
	"better_auth_user_id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_items" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_action" text NOT NULL,
	"state" text NOT NULL,
	"snapshot_version" integer NOT NULL,
	"snapshot_digest" text NOT NULL,
	CONSTRAINT "claim_items_target_type_check" CHECK ("claim_items"."target_type" in ('project','resource','agent','device','connection')),
	CONSTRAINT "claim_items_action_check" CHECK ("claim_items"."requested_action" in ('attach','transfer','delegate','verify')),
	CONSTRAINT "claim_items_state_check" CHECK ("claim_items"."state" in ('pending','accepted','rejected'))
);
--> statement-breakpoint
CREATE TABLE "claim_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"state" text NOT NULL,
	"creator_principal_id" text,
	"creator_agent_id" text,
	"creator_instance_id" text,
	"token_digest" "bytea" NOT NULL,
	"user_code_digest" "bytea",
	"proof_key_jkt" text,
	"target_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_manifest_digest" text NOT NULL,
	"requested_destination" jsonb,
	"requested_grant" jsonb,
	"presented_at" timestamp with time zone,
	"authenticated_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"completed_by_principal_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_sessions_type_check" CHECK ("claim_sessions"."type" in ('principal','agent','project','resource_bundle','device','connection')),
	CONSTRAINT "claim_sessions_state_check" CHECK ("claim_sessions"."state" in ('pending','presented','authenticated','reviewed','completed','denied','revoked','expired'))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"client_id" text NOT NULL,
	"sector_identifier" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organization_id" text,
	"project_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"project_id" text,
	"grant_id" text,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "delegations_relationship_check" CHECK ("delegations"."relationship" in ('owns','operates','delegates_to'))
);
--> statement-breakpoint
CREATE TABLE "device_authorization_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"device_code_digest" "bytea" NOT NULL,
	"user_code_digest" "bytea" NOT NULL,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proof_key_jkt" text,
	"state" text NOT NULL,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by_principal_id" text,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "device_auth_state_check" CHECK ("device_authorization_sessions"."state" in ('pending','approved','denied','expired','consumed'))
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"issuer" text NOT NULL,
	"tenant" text DEFAULT '' NOT NULL,
	"subject" text NOT NULL,
	"display_hint" text,
	"email_normalized" text,
	"email_verified" boolean,
	"assurance" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_mode" text NOT NULL,
	"display_name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sector_identifier" text NOT NULL,
	"grant_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"allowed_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_uri" text,
	"metadata_digest" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_admission_mode_check" CHECK ("oauth_clients"."admission_mode" in ('pre_registered','dynamic_registration','client_metadata_document','origin_profile')),
	CONSTRAINT "oauth_clients_state_check" CHECK ("oauth_clients"."state" in ('active','suspended','revoked'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_state_check" CHECK ("organizations"."state" in ('provisional','active','suspended','deleted'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "ownerships" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_claim_id" text,
	CONSTRAINT "ownerships_subject_type_check" CHECK ("ownerships"."subject_type" in ('principal','organization')),
	CONSTRAINT "ownerships_object_type_check" CHECK ("ownerships"."object_type" in ('project','resource','agent','device','connection')),
	CONSTRAINT "ownerships_relation_check" CHECK ("ownerships"."relation" in ('owner','custodian','administrator'))
);
--> statement-breakpoint
CREATE TABLE "pairwise_subjects" (
	"principal_id" text NOT NULL,
	"sector_identifier" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairwise_subjects_principal_id_sector_identifier_pk" PRIMARY KEY("principal_id","sector_identifier")
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"assurance" text NOT NULL,
	"verified_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_state_check" CHECK ("principals"."state" in ('provisional','active','suspended','closed')),
	CONSTRAINT "principals_assurance_check" CHECK ("principals"."assurance" in ('provisional','self_asserted','verified','mfa','phishing_resistant','enterprise_managed','workload_attested'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"owner_principal_id" text,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone,
	"claim_policy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_state_check" CHECK ("projects"."state" in ('provisional','active','expired','deleting','deleted'))
);
--> statement-breakpoint
CREATE TABLE "provisional_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"instance_key_jkt" text,
	"quota_profile" text NOT NULL,
	"allowed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"organization_id" text,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"owner_principal_id" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_state_check" CHECK ("resources"."state" in ('provisional','active','expired','deleting','deleted','quarantined'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_auth_subjects" ADD CONSTRAINT "better_auth_subjects_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_items" ADD CONSTRAINT "claim_items_claim_id_claim_sessions_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sessions" ADD CONSTRAINT "claim_sessions_creator_principal_id_principals_id_fk" FOREIGN KEY ("creator_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sessions" ADD CONSTRAINT "claim_sessions_creator_agent_id_agents_id_fk" FOREIGN KEY ("creator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sessions" ADD CONSTRAINT "claim_sessions_creator_instance_id_agent_instances_id_fk" FOREIGN KEY ("creator_instance_id") REFERENCES "public"."agent_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sessions" ADD CONSTRAINT "claim_sessions_completed_by_principal_id_principals_id_fk" FOREIGN KEY ("completed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorization_sessions" ADD CONSTRAINT "device_authorization_sessions_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorization_sessions" ADD CONSTRAINT "device_authorization_sessions_approved_by_principal_id_principals_id_fk" FOREIGN KEY ("approved_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_principals_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairwise_subjects" ADD CONSTRAINT "pairwise_subjects_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisional_sessions" ADD CONSTRAINT "provisional_sessions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instances_agent_id_idx" ON "agent_instances" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instances_public_key_jkt_uidx" ON "agent_instances" USING btree ("public_key_jkt");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_id_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_events_principal_id_idx" ON "audit_events" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "claim_items_claim_id_idx" ON "claim_items" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_sessions_token_digest_uidx" ON "claim_sessions" USING btree ("token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_sessions_active_user_code_uidx" ON "claim_sessions" USING btree ("user_code_digest") WHERE "claim_sessions"."user_code_digest" is not null and "claim_sessions"."state" in ('pending','presented','authenticated','reviewed') and "claim_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "claim_sessions_active_idx" ON "claim_sessions" USING btree ("state","expires_at") WHERE "claim_sessions"."state" in ('pending','presented','authenticated','reviewed') and "claim_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "consents_principal_client_idx" ON "consents" USING btree ("principal_id","client_id");--> statement-breakpoint
CREATE INDEX "delegations_principal_id_idx" ON "delegations" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "delegations_agent_id_idx" ON "delegations" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_auth_device_code_digest_uidx" ON "device_authorization_sessions" USING btree ("device_code_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "device_auth_active_user_code_uidx" ON "device_authorization_sessions" USING btree ("user_code_digest") WHERE "device_authorization_sessions"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "device_auth_active_idx" ON "device_authorization_sessions" USING btree ("state","expires_at") WHERE "device_authorization_sessions"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_kind_issuer_tenant_subject_uidx" ON "external_identities" USING btree ("kind","issuer","tenant","subject");--> statement-breakpoint
CREATE INDEX "external_identities_principal_id_idx" ON "external_identities" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "external_identities_email_normalized_idx" ON "external_identities" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uidx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownerships_subject_object_relation_uidx" ON "ownerships" USING btree ("subject_type","subject_id","object_type","object_id","relation");--> statement-breakpoint
CREATE INDEX "ownerships_object_idx" ON "ownerships" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairwise_subjects_sector_subject_uidx" ON "pairwise_subjects" USING btree ("sector_identifier","subject");--> statement-breakpoint
CREATE INDEX "projects_organization_id_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "projects_owner_principal_id_idx" ON "projects" USING btree ("owner_principal_id");--> statement-breakpoint
CREATE INDEX "provisional_sessions_principal_id_idx" ON "provisional_sessions" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "provisional_sessions_active_idx" ON "provisional_sessions" USING btree ("expires_at") WHERE "provisional_sessions"."revoked_at" is null and "provisional_sessions"."claimed_at" is null;--> statement-breakpoint
CREATE INDEX "resources_project_id_idx" ON "resources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "resources_organization_id_idx" ON "resources" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_slug_uidx" ON "teams" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "teams_organization_id_idx" ON "teams" USING btree ("organization_id");