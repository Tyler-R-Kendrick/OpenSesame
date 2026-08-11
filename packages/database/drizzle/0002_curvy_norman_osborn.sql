ALTER TABLE "agents" ADD COLUMN "owner_principal_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_principal_id_idx" ON "agents" USING btree ("owner_principal_id");