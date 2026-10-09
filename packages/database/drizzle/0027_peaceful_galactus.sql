CREATE TABLE "scim_group_role_mappings" (
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_role_mappings_pk" PRIMARY KEY("organization_id","group_id"),
	CONSTRAINT "scim_group_role_mappings_role_check" CHECK ("scim_group_role_mappings"."role" in ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "scim_group_role_mappings" ADD CONSTRAINT "scim_group_role_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_groups_organization_id_idx" ON "scim_groups" USING btree ("organization_id");