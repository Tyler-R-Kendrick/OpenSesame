CREATE TABLE "project_memberships" (
	"project_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_role_check" CHECK ("project_memberships"."role" in ('owner','admin','member'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_project_principal_uidx" ON "project_memberships" USING btree ("project_id","principal_id");--> statement-breakpoint
CREATE INDEX "project_memberships_principal_id_idx" ON "project_memberships" USING btree ("principal_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_project_id_idx" ON "agents" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_personal_owner_uidx" ON "projects" USING btree ("owner_principal_id") WHERE "projects"."kind" = 'personal';--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind_check" CHECK ("projects"."kind" in ('personal','standard','temporary'));