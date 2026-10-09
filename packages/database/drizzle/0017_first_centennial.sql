CREATE TABLE "authentication_aliases" (
	"application_id" text NOT NULL,
	"alias" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "authentication_aliases_application_id_alias_pk" PRIMARY KEY("application_id","alias")
);
--> statement-breakpoint
CREATE TABLE "authentication_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_principal_id" text NOT NULL,
	"organization_id" text,
	"display_name" text NOT NULL,
	"rp_id" text NOT NULL,
	"origins" jsonb NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_prefix" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authentication_applications_state_check" CHECK ("authentication_applications"."state" in ('active','suspended','revoked'))
);
--> statement-breakpoint
CREATE TABLE "authentication_challenges" (
	"challenge" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"purpose" text NOT NULL,
	"origin" text NOT NULL,
	"user_id" text,
	"registration_token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "authentication_challenges_purpose_check" CHECK ("authentication_challenges"."purpose" in ('registration','authentication'))
);
--> statement-breakpoint
CREATE TABLE "authentication_credentials" (
	"application_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"user_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authentication_credentials_application_id_credential_id_pk" PRIMARY KEY("application_id","credential_id")
);
--> statement-breakpoint
CREATE TABLE "authentication_registration_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"display_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "authentication_signin_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "authentication_users" (
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authentication_users_application_id_user_id_pk" PRIMARY KEY("application_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "authentication_aliases" ADD CONSTRAINT "authentication_aliases_application_id_authentication_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."authentication_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_applications" ADD CONSTRAINT "authentication_applications_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_challenges" ADD CONSTRAINT "authentication_challenges_application_id_authentication_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."authentication_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_credentials" ADD CONSTRAINT "authentication_credentials_application_id_authentication_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."authentication_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_registration_tokens" ADD CONSTRAINT "authentication_registration_tokens_application_id_authentication_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."authentication_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_signin_tokens" ADD CONSTRAINT "authentication_signin_tokens_application_id_authentication_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."authentication_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_users" ADD CONSTRAINT "authentication_users_application_id_authentication_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."authentication_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authentication_aliases_user_idx" ON "authentication_aliases" USING btree ("application_id","user_id");--> statement-breakpoint
CREATE INDEX "authentication_applications_owner_idx" ON "authentication_applications" USING btree ("owner_principal_id");--> statement-breakpoint
CREATE INDEX "authentication_applications_org_idx" ON "authentication_applications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "authentication_challenges_expiry_idx" ON "authentication_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "authentication_credentials_user_idx" ON "authentication_credentials" USING btree ("application_id","user_id");--> statement-breakpoint
CREATE INDEX "authentication_registration_tokens_expiry_idx" ON "authentication_registration_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "authentication_signin_tokens_expiry_idx" ON "authentication_signin_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "authentication_users_app_idx" ON "authentication_users" USING btree ("application_id");