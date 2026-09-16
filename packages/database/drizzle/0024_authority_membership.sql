CREATE TABLE "authority_membership_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cohort_id" text NOT NULL,
	"subject_principal_id" text NOT NULL,
	"relation" text NOT NULL,
	"subject_kind" text NOT NULL,
	"source" text NOT NULL,
	"issuing_authority" text NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_membership_edges_relation_check" CHECK ("authority_membership_edges"."relation" in ('member','nested_cohort','observer')),
	CONSTRAINT "authority_membership_edges_subject_kind_check" CHECK ("authority_membership_edges"."subject_kind" in ('person','service','agent_registration','workload_instance','device')),
	CONSTRAINT "authority_membership_edges_interval_check" CHECK ("authority_membership_edges"."expires_at" is null or "authority_membership_edges"."expires_at" > "authority_membership_edges"."not_before"),
	CONSTRAINT "authority_membership_edges_revision_check" CHECK ("authority_membership_edges"."revision" > 0),
	CONSTRAINT "authority_membership_edges_invalidation_check" CHECK (("authority_membership_edges"."invalidated_at" is null) = ("authority_membership_edges"."invalidated_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "authority_projection_state" (
	"organization_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"committed_revision" integer NOT NULL,
	"applied_revision" integer DEFAULT 0 NOT NULL,
	"authorization_model_id" text,
	"dirty_since" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_projection_state_pkey" PRIMARY KEY("organization_id","subject_kind","subject_id"),
	CONSTRAINT "authority_projection_state_progress_check" CHECK ("authority_projection_state"."applied_revision" <= "authority_projection_state"."committed_revision"),
	CONSTRAINT "authority_projection_state_committed_check" CHECK ("authority_projection_state"."committed_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "authority_membership_edges" ADD CONSTRAINT "authority_membership_edges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_membership_edges" ADD CONSTRAINT "authority_membership_edges_subject_principal_id_principals_id_fk" FOREIGN KEY ("subject_principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_projection_state" ADD CONSTRAINT "authority_projection_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authority_membership_edges_realm_edge_uidx" ON "authority_membership_edges" USING btree ("organization_id","cohort_id","subject_principal_id","relation");--> statement-breakpoint
CREATE INDEX "authority_membership_edges_subject_idx" ON "authority_membership_edges" USING btree ("organization_id","subject_principal_id");--> statement-breakpoint
CREATE INDEX "authority_membership_edges_cohort_idx" ON "authority_membership_edges" USING btree ("organization_id","cohort_id","revision");