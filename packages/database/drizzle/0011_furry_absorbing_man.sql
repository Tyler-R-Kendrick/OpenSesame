CREATE TABLE "client_claim_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_origins" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"canonical_origin" text NOT NULL,
	"public_client_id" text NOT NULL,
	"verification_method" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_origins_status_check" CHECK ("client_origins"."status" in ('active','revoked','pending'))
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "ownership_status" text DEFAULT 'unclaimed' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_claim_challenges" ADD CONSTRAINT "client_claim_challenges_application_id_oauth_clients_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_claim_challenges" ADD CONSTRAINT "client_claim_challenges_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_origins" ADD CONSTRAINT "client_origins_application_id_oauth_clients_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_claim_challenges_challenge_uidx" ON "client_claim_challenges" USING btree ("challenge");--> statement-breakpoint
CREATE INDEX "client_claim_challenges_app_idx" ON "client_claim_challenges" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_origins_canonical_uidx" ON "client_origins" USING btree ("canonical_origin");--> statement-breakpoint
CREATE UNIQUE INDEX "client_origins_public_client_uidx" ON "client_origins" USING btree ("public_client_id");--> statement-breakpoint
CREATE INDEX "client_origins_application_idx" ON "client_origins" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_origin_uidx" ON "oauth_clients" USING btree ("origin") WHERE "oauth_clients"."origin" is not null;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_ownership_status_check" CHECK ("oauth_clients"."ownership_status" in ('unclaimed','claimed'));